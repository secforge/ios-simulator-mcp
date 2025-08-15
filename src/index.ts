#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";
import { Client } from "ssh2";
import { createSetupTool } from "./setup-tool.js";

const execFileAsync = promisify(execFile);

/**
 * Strict UDID/UUID pattern: 8-4-4-4-12 hexadecimal characters (e.g. 37A360EC-75F9-4AEC-8EFA-10F4A58D8CCA)
 */
const UDID_REGEX =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const TMP_ROOT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ios-simulator-mcp-")
);

// SSH Configuration
interface SSHConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
}

// Read SSH configuration from environment variables
function getSSHConfig(): SSHConfig | null {
  const host = process.env.IOS_SIMULATOR_SSH_HOST;
  if (!host) return null;

  return {
    host,
    port: parseInt(process.env.IOS_SIMULATOR_SSH_PORT || "22"),
    username: process.env.IOS_SIMULATOR_SSH_USERNAME || "user",
    privateKeyPath: process.env.IOS_SIMULATOR_SSH_KEY_PATH,
    password: process.env.IOS_SIMULATOR_SSH_PASSWORD,
  };
}

/**
 * Creates SSH connection options based on configuration
 */
function createSSHConnectionOptions() {
  if (!sshConfig) {
    throw new Error("SSH configuration not available");
  }

  const connectOptions: any = {
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.username,
  };

  if (sshConfig.privateKeyPath) {
    connectOptions.privateKey = fs.readFileSync(sshConfig.privateKeyPath);
  } else if (sshConfig.password) {
    connectOptions.password = sshConfig.password;
  } else {
    connectOptions.agent = process.env.SSH_AUTH_SOCK;
  }

  return connectOptions;
}

// SSH Connection Pool
let sshConnectionPool: Client | null = null;
let sshConnectionPromise: Promise<Client> | null = null;

/**
 * Gets or creates a persistent SSH connection
 */
async function getSSHConnection(): Promise<Client> {
  if (sshConnectionPool && (sshConnectionPool as any)._sock && !(sshConnectionPool as any)._sock.destroyed) {
    return sshConnectionPool;
  }

  // If connection is already being established, wait for it
  if (sshConnectionPromise) {
    return sshConnectionPromise;
  }

  sshConnectionPromise = new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      sshConnectionPool = conn;
      sshConnectionPromise = null;
      resolve(conn);
    });

    conn.on('error', (err) => {
      sshConnectionPool = null;
      sshConnectionPromise = null;
      reject(err);
    });

    conn.on('end', () => {
      sshConnectionPool = null;
    });

    conn.on('close', () => {
      sshConnectionPool = null;
    });

    try {
      conn.connect(createSSHConnectionOptions());
    } catch (error) {
      sshConnectionPool = null;
      sshConnectionPromise = null;
      reject(error);
    }
  });

  return sshConnectionPromise;
}

/**
 * Executes a command over SSH with proper shell environment using connection pooling
 * Includes automatic retry on connection failures
 */
async function sshExec(command: string, retryCount = 0): Promise<{ stdout: string; stderr: string }> {
  try {
    const conn = await getSSHConnection();
    
    return new Promise((resolve, reject) => {
      const fullCommand = `source ~/.zshrc 2>/dev/null || source ~/.bash_profile 2>/dev/null || true; ${command}`;
      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          // Connection may have broken, clear the pool and retry once
          if (retryCount === 0 && (err.message.includes('Not connected') || err.message.includes('connection'))) {
            sshConnectionPool = null;
            sshExec(command, retryCount + 1).then(resolve, reject);
            return;
          }
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code: number) => {
          if (code === 0) {
            resolve({
              stdout: stdout.trim(),
              stderr: stderr.trim(),
            });
          } else {
            reject(new Error(`Command failed with exit code ${code}: ${stderr || stdout}`));
          }
        });

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
  } catch (error) {
    // Connection establishment failed, retry once if first attempt
    if (retryCount === 0) {
      sshConnectionPool = null;
      return sshExec(command, retryCount + 1);
    }
    throw error;
  }
}

/**
 * Get the full path to the idb command for SSH execution
 * First tries environment variable, then tries common locations
 */
async function getIdbPath(): Promise<string> {
  // Check if custom path is specified
  const customPath = process.env.IOS_SIMULATOR_IDB_PATH;
  if (customPath) {
    return customPath;
  }

  // Try to find idb in common locations
  const commonPaths = [
    'idb', // Try system PATH first
    '/opt/homebrew/bin/idb',
    '/usr/local/bin/idb',
    '$HOME/.local/bin/idb',
  ];

  for (const path of commonPaths) {
    try {
      await sshExec(`which ${path}`);
      return path;
    } catch {
      // Continue to next path
    }
  }

  // Try Python user bin directory (common for pip installs)
  try {
    const { stdout } = await sshExec('python3 -m site --user-base');
    const userBase = stdout.trim();
    const pythonIdbPath = `${userBase}/bin/idb`;
    await sshExec(`test -f ${pythonIdbPath}`);
    return pythonIdbPath;
  } catch {
    // Fall back to idb if nothing else works
    return 'idb';
  }
}

const sshConfig = getSSHConfig();

// Global variable to track SSH recording info
let sshRecordingInfo: { remotePath: string; localPath: string } | null = null;

/**
 * Runs a command with arguments and returns the stdout and stderr
 * Automatically routes to SSH execution if SSH configuration is present
 * @param cmd - The command to run
 * @param args - The arguments to pass to the command
 * @returns The stdout and stderr of the command
 */
async function run(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    if (sshConfig) {
      return runSSH(cmd, args);
    } else {
      const { stdout, stderr } = await execFileAsync(cmd, args, { shell: false });
      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    }
  } catch (error) {
    throw enhanceErrorWithSetupGuidance(error as Error);
  }
}

// Cache for idb path to avoid repeated lookups
let cachedIdbPath: string | null = null;

/**
 * Checks if an error indicates missing setup/dependencies
 */
function isSetupRelatedError(error: Error): boolean {
  const setupIndicators = [
    'idb: command not found',
    'command not found',
    'xcrun: error: unable to find utility "simctl"',
    'brew: command not found', 
    'python3: command not found',
    'pip3: command not found',
    'No such file or directory',
    'Permission denied',
    'Connection refused',
    'idb_companion',
    'Failed to connect to idb companion'
  ];
  
  return setupIndicators.some(indicator => 
    error.message.toLowerCase().includes(indicator.toLowerCase())
  );
}

/**
 * Enhanced error with setup guidance for SSH mode
 */
function enhanceErrorWithSetupGuidance(error: Error): Error {
  if (sshConfig && isSetupRelatedError(error)) {
    return new Error(
      `Command failed - this may indicate the remote macOS host needs setup.\n\n` +
      `Try asking your AI assistant: "Setup the remote macOS host for iOS simulator access"\n\n` +
      `Original error: ${error.message}`
    );
  }
  return error;
}

/**
 * Runs a command over SSH with argument escaping and idb path resolution
 */
async function runSSH(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  try {
    // Resolve idb path if needed
    let finalCmd = cmd;
    if (cmd === 'idb') {
      if (!cachedIdbPath) {
        cachedIdbPath = await getIdbPath();
      }
      finalCmd = cachedIdbPath;
    }

    // Escape arguments for shell execution
    const escapedArgs = args.map(arg => `'${arg.replace(/'/g, "'\"'\"'")}'`);
    const command = `${finalCmd} ${escapedArgs.join(' ')}`;
    
    return sshExec(command);
  } catch (error) {
    throw enhanceErrorWithSetupGuidance(error as Error);
  }
}

/**
 * Downloads a file from the remote macOS host via SSH using connection pooling
 * Includes automatic retry on connection failures
 */
async function downloadFileSSH(remotePath: string, localPath: string, retryCount = 0): Promise<void> {
  try {
    const conn = await getSSHConnection();
    
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          // Connection may have broken, clear the pool and retry once
          if (retryCount === 0 && (err.message.includes('Not connected') || err.message.includes('connection'))) {
            sshConnectionPool = null;
            downloadFileSSH(remotePath, localPath, retryCount + 1).then(resolve, reject);
            return;
          }
          reject(err);
          return;
        }

        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  } catch (error) {
    // Connection establishment failed, retry once if first attempt
    if (retryCount === 0) {
      sshConnectionPool = null;
      return downloadFileSSH(remotePath, localPath, retryCount + 1);
    }
    throw error;
  }
}

// Read filtered tools from environment variable
const FILTERED_TOOLS =
  process.env.IOS_SIMULATOR_MCP_FILTERED_TOOLS?.split(",").map((tool) =>
    tool.trim()
  ) || [];

// Function to check if a tool is filtered
function isToolFiltered(toolName: string): boolean {
  return FILTERED_TOOLS.includes(toolName);
}

const server = new McpServer({
  name: "ios-simulator",
  version: require("../package.json").version,
});

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

/**
 * Helper to create tool response with consistent error handling
 */
function createToolResponse(content: string) {
  return {
    isError: false,
    content: [
      {
        type: "text" as const,
        text: content,
      },
    ],
  };
}

/**
 * Helper to create error response with troubleshooting guidance
 */
function createErrorResponse(error: unknown) {
  const errorObj = toError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: errorWithTroubleshooting(errorObj.message),
      },
    ],
  };
}

/**
 * Helper to run idb UI command with UDID validation
 */
async function runIdbUICommand(udid: string | undefined, subcommand: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  const actualUdid = await getBootedDeviceId(udid);
  return run("idb", ["ui", subcommand, "--udid", actualUdid, ...args]);
}

/**
 * Common Zod schema for UDID parameter
 */
const udidSchema = z
  .string()
  .regex(UDID_REGEX)
  .optional()
  .describe("Udid of target, can also be set with the IDB_UDID env var");

function troubleshootingLink(): string {
  return "[Troubleshooting Guide](https://github.com/joshuayoes/ios-simulator-mcp/blob/main/TROUBLESHOOTING.md) | [Plain Text Guide for LLMs](https://raw.githubusercontent.com/joshuayoes/ios-simulator-mcp/refs/heads/main/TROUBLESHOOTING.md)";
}

function errorWithTroubleshooting(message: string): string {
  let guidance = `${message}\n\nFor help, see the ${troubleshootingLink()}`;
  
  // Add setup guidance for SSH mode
  if (sshConfig) {
    guidance += `\n\nIf using SSH mode and tools are missing, try asking: "Setup the remote macOS host for iOS simulator access"`;
  }
  
  return guidance;
}

async function getBootedDevice() {
  const { stdout, stderr } = await run("xcrun", ["simctl", "list", "devices"]);

  if (stderr) throw new Error(stderr);

  // Parse the output to find booted device
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("Booted")) {
      // Extract the UUID - it's inside parentheses
      const match = line.match(/\(([-0-9A-F]+)\)/);
      if (match) {
        const deviceId = match[1];
        const deviceName = line.split("(")[0].trim();
        return {
          name: deviceName,
          id: deviceId,
        };
      }
    }
  }

  throw Error("No booted simulator found");
}

async function getBootedDeviceId(
  deviceId: string | undefined
): Promise<string> {
  // If deviceId not provided, get the currently booted simulator
  let actualDeviceId = deviceId;
  if (!actualDeviceId) {
    const { id } = await getBootedDevice();
    actualDeviceId = id;
  }
  if (!actualDeviceId) {
    throw new Error("No booted simulator found and no deviceId provided");
  }
  return actualDeviceId;
}

// Register tools only if they're not filtered
if (!isToolFiltered("get_booted_sim_id")) {
  server.tool(
    "get_booted_sim_id",
    "Get the ID of the currently booted iOS simulator",
    async () => {
      try {
        const { id, name } = await getBootedDevice();
        return createToolResponse(`Booted Simulator: "${name}". UUID: "${id}"`);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}

if (!isToolFiltered("ui_describe_all")) {
  server.tool(
    "ui_describe_all",
    "Describes accessibility information for the entire screen in the iOS Simulator",
    {
      udid: udidSchema,
    },
    async ({ udid }) => {
      try {
        const { stdout } = await runIdbUICommand(udid, "describe-all", ["--json", "--nested"]);
        return createToolResponse(stdout);
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}

if (!isToolFiltered("ui_tap")) {
  server.tool(
    "ui_tap",
    "Tap on the screen in the iOS Simulator",
    {
      duration: z
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .optional()
        .describe("Press duration"),
      udid: udidSchema,
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The x-coordinate"),
    },
    async ({ duration, udid, x, y }) => {
      try {
        const { stderr } = await runIdbUICommand(udid, "tap", [
          ...(duration ? ["--duration", duration] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y),
        ]);

        if (stderr) throw new Error(stderr);
        return createToolResponse("Tapped successfully");
      } catch (error) {
        return createErrorResponse(error);
      }
    }
  );
}

if (!isToolFiltered("ui_type")) {
  server.tool(
    "ui_type",
    "Input text into the iOS Simulator",
    {
      udid: udidSchema,
      text: z
        .string()
        .max(500)
        .regex(/^[\x20-\x7E]+$/)
        .describe("Text to input"),
    },
    async ({ udid, text }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await run("idb", [
          "ui",
          "text",
          "--udid",
          actualUdid,
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          text,
        ]);

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Typed successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error typing text into the iOS Simulator: ${
                  toError(error).message
                }`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_swipe")) {
  server.tool(
    "ui_swipe",
    "Swipe on the screen in the iOS Simulator",
    {
      udid: udidSchema,
      x_start: z.number().describe("The starting x-coordinate"),
      y_start: z.number().describe("The starting y-coordinate"),
      x_end: z.number().describe("The ending x-coordinate"),
      y_end: z.number().describe("The ending y-coordinate"),
      delta: z
        .number()
        .optional()
        .describe("The size of each step in the swipe (default is 1)")
        .default(1),
    },
    async ({ udid, x_start, y_start, x_end, y_end, delta }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stderr } = await run("idb", [
          "ui",
          "swipe",
          "--udid",
          actualUdid,
          ...(delta ? ["--delta", String(delta)] : []),
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x_start),
          String(y_start),
          String(x_end),
          String(y_end),
        ]);

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: "Swiped successfully" }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error swiping on the screen: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_describe_point")) {
  server.tool(
    "ui_describe_point",
    "Returns the accessibility element at given co-ordinates on the iOS Simulator's screen",
    {
      udid: udidSchema,
      x: z.number().describe("The x-coordinate"),
      y: z.number().describe("The y-coordinate"),
    },
    async ({ udid, x, y }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        const { stdout, stderr } = await run("idb", [
          "ui",
          "describe-point",
          "--udid",
          actualUdid,
          "--json",
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          String(x),
          String(y),
        ]);

        if (stderr) throw new Error(stderr);

        return {
          isError: false,
          content: [{ type: "text", text: stdout }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error describing point (${x}, ${y}): ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("ui_view")) {
  server.tool(
    "ui_view",
    "Get the image content of a compressed screenshot of the current simulator view",
    {
      udid: udidSchema,
    },
    async ({ udid }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);

        // Get screen dimensions in points from ui_describe_all
        const { stdout: uiDescribeOutput } = await run("idb", [
          "ui",
          "describe-all",
          "--udid",
          actualUdid,
          "--json",
          "--nested",
        ]);

        const uiData = JSON.parse(uiDescribeOutput);
        const screenFrame = uiData[0]?.frame;
        if (!screenFrame) {
          throw new Error("Could not determine screen dimensions");
        }

        const pointWidth = screenFrame.width;
        const pointHeight = screenFrame.height;

        // Generate unique file names with timestamp
        const ts = Date.now();
        let rawPng: string;
        let compressedJpg: string;
        
        if (sshConfig) {
          // Use remote paths when SSH is configured
          rawPng = `/tmp/ui-view-${ts}-raw.png`;
          compressedJpg = `/tmp/ui-view-${ts}-compressed.jpg`;
        } else {
          // Use local temp directory when running locally
          rawPng = path.join(TMP_ROOT_DIR, `ui-view-${ts}-raw.png`);
          compressedJpg = path.join(TMP_ROOT_DIR, `ui-view-${ts}-compressed.jpg`);
        }

        // Capture screenshot as PNG
        await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          "--type=png",
          "--",
          rawPng,
        ]);

        // Resize to match point dimensions and compress to JPEG using sips
        await run("sips", [
          "-z",
          String(pointHeight), // height in points
          String(pointWidth),  // width in points
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "80", // 80% quality
          rawPng,
          "--out",
          compressedJpg,
        ]);

        // Read and encode the compressed image
        let imageData: Buffer;
        if (sshConfig) {
          // Download the file from remote host
          const localFile = path.join(TMP_ROOT_DIR, `ui-view-${ts}-compressed.jpg`);
          await downloadFileSSH(compressedJpg, localFile);
          imageData = fs.readFileSync(localFile);
          
          // Clean up remote files
          await run("rm", [rawPng, compressedJpg]);
        } else {
          imageData = fs.readFileSync(compressedJpg);
        }
        const base64Data = imageData.toString("base64");

        return {
          isError: false,
          content: [
            {
              type: "image",
              data: base64Data,
              mimeType: "image/jpeg",
            },
            {
              type: "text",
              text: "Screenshot captured",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error capturing screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

function ensureAbsolutePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Handle ~/something paths
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  // For relative paths, try ~/Downloads first, fall back to system temp
  const downloadsDir = path.join(os.homedir(), "Downloads");
  try {
    // Check if Downloads directory exists and is accessible
    fs.accessSync(downloadsDir, fs.constants.W_OK);
    return path.join(downloadsDir, filePath);
  } catch {
    // Fall back to system temp directory
    return path.join(os.tmpdir(), filePath);
  }
}

if (!isToolFiltered("screenshot")) {
  server.tool(
    "screenshot",
    "Takes a screenshot of the iOS Simulator",
    {
      udid: udidSchema,
      output_path: z
        .string()
        .max(1024)
        .describe(
          "File path where the screenshot will be saved (if relative, ~/Downloads will be used as base directory)"
        ),
      type: z
        .enum(["png", "tiff", "bmp", "gif", "jpeg"])
        .optional()
        .describe(
          "Image format (png, tiff, bmp, gif, or jpeg). Default is png."
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          "Display to capture (internal or external). Default depends on device type."
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          "For non-rectangular displays, handle the mask by policy (ignored, alpha, or black)"
        ),
    },
    async ({ udid, output_path, type, display, mask }) => {
      try {
        const actualUdid = await getBootedDeviceId(udid);
        const absolutePath = ensureAbsolutePath(output_path);

        let remotePath: string;
        let finalPath: string;
        
        if (sshConfig) {
          // Use remote temp path, then download
          const ts = Date.now();
          remotePath = `/tmp/screenshot-${ts}.${type || 'png'}`;
          finalPath = absolutePath;
        } else {
          // Use the final path directly
          remotePath = absolutePath;
          finalPath = absolutePath;
        }

        // command is weird, it responds with stderr on success and stdout is blank
        const { stderr: stdout } = await run("xcrun", [
          "simctl",
          "io",
          actualUdid,
          "screenshot",
          ...(type ? [`--type=${type}`] : []),
          ...(display ? [`--display=${display}`] : []),
          ...(mask ? [`--mask=${mask}`] : []),
          // When passing user-provided values to a command, it's crucial to use `--`
          // to separate the command's options from positional arguments.
          // This prevents the shell from misinterpreting the arguments as options.
          "--",
          remotePath,
        ]);

        // throw if we don't get the expected success message
        if (stdout && !stdout.includes("Wrote screenshot to")) {
          throw new Error(stdout);
        }

        // If using SSH, download the file to the final location
        if (sshConfig) {
          await downloadFileSSH(remotePath, finalPath);
          // Clean up remote file
          await run("rm", [remotePath]);
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Screenshot saved to ${finalPath}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error taking screenshot: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("record_video")) {
  server.tool(
    "record_video",
    "Records a video of the iOS Simulator using simctl directly",
    {
      output_path: z
        .string()
        .max(1024)
        .optional()
        .describe(
          `Optional output path (defaults to ~/Downloads/simulator_recording_$DATE.mp4)`
        ),
      codec: z
        .enum(["h264", "hevc"])
        .optional()
        .describe(
          'Specifies the codec type: "h264" or "hevc". Default is "hevc".'
        ),
      display: z
        .enum(["internal", "external"])
        .optional()
        .describe(
          'Display to capture: "internal" or "external". Default depends on device type.'
        ),
      mask: z
        .enum(["ignored", "alpha", "black"])
        .optional()
        .describe(
          'For non-rectangular displays, handle the mask by policy: "ignored", "alpha", or "black".'
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Force the output file to be written to, even if the file already exists."
        ),
    },
    async ({ output_path, codec, display, mask, force }) => {
      try {
        const defaultFileName = `simulator_recording_${Date.now()}.mp4`;
        const outputFile = ensureAbsolutePath(output_path ?? defaultFileName);

        let remotePath: string;
        let finalPath: string;
        
        if (sshConfig) {
          // Use remote temp path for SSH
          const ts = Date.now();
          remotePath = `/tmp/simulator_recording_${ts}.mp4`;
          finalPath = outputFile;
          sshRecordingInfo = { remotePath, localPath: finalPath };
        } else {
          // Use the final path directly for local execution
          remotePath = outputFile;
          finalPath = outputFile;
        }

        if (sshConfig) {
          // For SSH, we need to start recording on the remote host in background
          // We'll use sh -c to handle the background process properly
          await runSSH("sh", [
            "-c",
            `nohup xcrun simctl io booted recordVideo ${codec ? `--codec=${codec}` : ''} ${display ? `--display=${display}` : ''} ${mask ? `--mask=${mask}` : ''} ${force ? '--force' : ''} '${remotePath}' > /dev/null 2>&1 &`
          ]);
        } else {
          // Start the recording process locally
          const recordingProcess = spawn("xcrun", [
            "simctl",
            "io",
            "booted",
            "recordVideo",
            ...(codec ? [`--codec=${codec}`] : []),
            ...(display ? [`--display=${display}`] : []),
            ...(mask ? [`--mask=${mask}`] : []),
            ...(force ? ["--force"] : []),
            // When passing user-provided values to a command, it's crucial to use `--`
            // to separate the command's options from positional arguments.
            // This prevents the shell from misinterpreting the arguments as options.
            "--",
            outputFile,
          ]);

          // Wait for recording to start
          await new Promise((resolve, reject) => {
            let errorOutput = "";

            recordingProcess.stderr.on("data", (data) => {
              const message = data.toString();
              if (message.includes("Recording started")) {
                resolve(true);
              } else {
                errorOutput += message;
              }
            });

            // Set timeout for start verification
            setTimeout(() => {
              if (recordingProcess.killed) {
                reject(new Error("Recording process terminated unexpectedly"));
              } else {
                resolve(true);
              }
            }, 3000);
          });
        }

        // For SSH, wait a moment to ensure the recording has started
        if (sshConfig) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Recording started. The video will be saved to: ${finalPath}\nTo stop recording, use the stop_recording command.`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("stop_recording")) {
  server.tool(
    "stop_recording",
    "Stops the simulator video recording using killall",
    {},
    async () => {
      try {
        await run("pkill", ["-SIGINT", "-f", "simctl.*recordVideo"]);

        // Wait a moment for the video to finalize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // If using SSH and we have recording info, download the video
        if (sshConfig && sshRecordingInfo) {
          try {
            await downloadFileSSH(sshRecordingInfo.remotePath, sshRecordingInfo.localPath);
            // Clean up remote file
            await run("rm", [sshRecordingInfo.remotePath]);
            const message = `Recording stopped and downloaded to: ${sshRecordingInfo.localPath}`;
            sshRecordingInfo = null; // Clear the recording info
            return {
              isError: false,
              content: [
                {
                  type: "text",
                  text: message,
                },
              ],
            };
          } catch (downloadError) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Recording stopped but failed to download video: ${toError(downloadError).message}`,
                },
              ],
            };
          }
        }

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: "Recording stopped successfully.",
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping recording: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("simulator_stop")) {
  server.tool(
    "simulator_stop",
    "Stop a running iOS simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target simulator, can also be set with the IDB_UDID env var. If not provided, stops all simulators"),
    },
    async ({ udid }) => {
      try {
        if (udid) {
          // Stop specific simulator
          await run("xcrun", ["simctl", "shutdown", udid]);
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `Simulator ${udid} stopped successfully`,
              },
            ],
          };
        } else {
          // Stop all simulators
          await run("xcrun", ["simctl", "shutdown", "all"]);
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: "All simulators stopped successfully",
              },
            ],
          };
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error stopping simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("simulator_start")) {
  server.tool(
    "simulator_start",
    "Start an iOS simulator",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target simulator to start. If not provided, starts the default iPhone 16 Pro"),
      device_name: z
        .string()
        .optional()
        .describe("Device name to start (e.g., 'iPhone 16 Pro'). Used if udid is not provided"),
    },
    async ({ udid, device_name }) => {
      try {
        let targetId = udid;
        
        if (!targetId) {
          // If no UDID provided, try to find device by name or use default
          const deviceToStart = device_name || "iPhone 16 Pro";
          const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
          const devices = JSON.parse(stdout);
          
          // Find the device by name
          for (const runtime in devices.devices) {
            const runtimeDevices = devices.devices[runtime];
            const device = runtimeDevices.find((d: any) => d.name === deviceToStart);
            if (device) {
              targetId = device.udid;
              break;
            }
          }
          
          if (!targetId) {
            throw new Error(`Device "${deviceToStart}" not found`);
          }
        }
        
        await run("xcrun", ["simctl", "boot", targetId]);
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Simulator ${targetId} started successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error starting simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

if (!isToolFiltered("simulator_restart")) {
  server.tool(
    "simulator_restart",
    "Restart an iOS simulator (stop and start)",
    {
      udid: z
        .string()
        .regex(UDID_REGEX)
        .optional()
        .describe("Udid of target simulator to restart. If not provided, restarts the currently booted simulator"),
      device_name: z
        .string()
        .optional()
        .describe("Device name to restart (e.g., 'iPhone 16 Pro'). Used if udid is not provided"),
    },
    async ({ udid, device_name }) => {
      try {
        let targetId = udid;
        
        if (!targetId) {
          try {
            // Try to get currently booted device
            targetId = await getBootedDeviceId(undefined);
          } catch {
            // If no booted device, find by name or use default
            const deviceToRestart = device_name || "iPhone 16 Pro";
            const { stdout } = await run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
            const devices = JSON.parse(stdout);
            
            for (const runtime in devices.devices) {
              const runtimeDevices = devices.devices[runtime];
              const device = runtimeDevices.find((d: any) => d.name === deviceToRestart);
              if (device) {
                targetId = device.udid;
                break;
              }
            }
            
            if (!targetId) {
              throw new Error(`Device "${deviceToRestart}" not found`);
            }
          }
        }
        
        // Stop the simulator
        await run("xcrun", ["simctl", "shutdown", targetId]);
        
        // Wait a moment for clean shutdown
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Start the simulator
        await run("xcrun", ["simctl", "boot", targetId]);
        
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: `Simulator ${targetId} restarted successfully`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: errorWithTroubleshooting(
                `Error restarting simulator: ${toError(error).message}`
              ),
            },
          ],
        };
      }
    }
  );
}

// Add the setup tool
if (!isToolFiltered("setup_remote_host")) {
  const setupTool = createSetupTool({
    sshConfig,
    runSSH: sshConfig ? runSSH : undefined
  });
  
  server.tool(
    setupTool.name,
    setupTool.description,
    setupTool.inputSchema,
    async (args: any) => {
      try {
        return await setupTool.handler(args);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Setup failed: ${errorMessage}\n\nPlease check SSH connectivity and ensure you can manually SSH to the host.`,
            },
          ],
        };
      }
    }
  );
}

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);

process.stdin.on("close", () => {
  console.log("iOS Simulator MCP Server closed");
  server.close();
  
  // Close SSH connection if active
  if (sshConnectionPool) {
    sshConnectionPool.end();
  }
  
  try {
    fs.rmSync(TMP_ROOT_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
});
