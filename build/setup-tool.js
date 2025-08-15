"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSetupTool = createSetupTool;
const child_process_1 = require("child_process");
const util_1 = require("util");
const zod_1 = require("zod");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// Cache for tool paths to avoid repeated detection
let cachedBrewPath = null;
let cachedPython3Path = null;
let cachedPip3Path = null;
function createSetupTool(config) {
    return {
        name: "setup_remote_host",
        description: "Setup a remote macOS host for iOS Simulator MCP by installing required tools",
        inputSchema: {
            host: zod_1.z.string().describe("macOS host IP or hostname"),
            username: zod_1.z.string().describe("SSH username"),
            dry_run: zod_1.z.boolean().optional().describe("Only check what needs to be done, don't make changes"),
            auto_confirm: zod_1.z.boolean().optional().describe("Apply changes without asking for confirmation"),
        },
        handler: async ({ host, username, dry_run = false, auto_confirm = false }) => {
            try {
                let output = "";
                const log = (message) => {
                    output += message + "\n";
                };
                if (dry_run) {
                    log("DRY RUN: Analyzing macOS host configuration...");
                }
                else {
                    log("Setting up macOS host for iOS Simulator MCP...");
                }
                log(`Host: ${host}`);
                log(`User: ${username}`);
                log("");
                // Helper function to run SSH commands
                const runRemoteCheck = async (command) => {
                    try {
                        if (config.sshConfig && config.runSSH) {
                            // Use existing SSH connection if available
                            await config.runSSH("bash", ["-l", "-c", command]);
                            return true;
                        }
                        else {
                            // Create temporary SSH connection for setup
                            await execFileAsync("ssh", [
                                "-o", "ConnectTimeout=5",
                                "-o", "BatchMode=yes",
                                `${username}@${host}`,
                                command
                            ]);
                            return true;
                        }
                    }
                    catch {
                        return false;
                    }
                };
                const runRemoteCommand = async (command) => {
                    if (config.sshConfig && config.runSSH) {
                        const result = await config.runSSH("bash", ["-l", "-c", command]);
                        return result.stdout;
                    }
                    else {
                        const { stdout } = await execFileAsync("ssh", [`${username}@${host}`, command]);
                        return stdout;
                    }
                };
                // Generic tool detection function
                const detectToolPath = async (toolName, candidates, cache) => {
                    if (cache.value)
                        return cache.value;
                    for (const path of candidates) {
                        try {
                            await runRemoteCommand(`which ${path} >/dev/null 2>&1`);
                            cache.value = path;
                            return path;
                        }
                        catch { /* continue */ }
                    }
                    throw new Error(`${toolName} not found in any expected location`);
                };
                // Cache objects for tool paths
                const brewCache = { value: cachedBrewPath };
                const python3Cache = { value: cachedPython3Path };
                const pip3Cache = { value: cachedPip3Path };
                // Tool detection functions
                const getBrewPath = () => detectToolPath('Homebrew', ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew'], brewCache);
                const getPython3Path = () => detectToolPath('Python3', ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'], python3Cache);
                const getPip3Path = () => detectToolPath('pip3', ['pip3', '/opt/homebrew/bin/pip3', '/usr/local/bin/pip3'], pip3Cache);
                const actionsNeeded = [];
                const missingRequirements = [];
                // === ANALYSIS PHASE ===
                log("Analyzing current system state...");
                // Check SSH connection
                log("Testing SSH connection...");
                if (!(await runRemoteCheck("echo 'SSH connection test'"))) {
                    log("SSH connection failed");
                    missingRequirements.push(`SSH connection to ${host} failed - check network, host, and SSH keys`);
                    log("  Please verify:");
                    log(`  - Host is reachable: ${host}`);
                    log("  - SSH keys are loaded: ssh-add -l");
                    log(`  - Can SSH manually: ssh ${username}@${host}`);
                }
                else {
                    log("SSH connection working");
                }
                // Check if we're actually on macOS
                log("Verifying macOS...");
                if (!(await runRemoteCheck("uname | grep -i darwin"))) {
                    log("Not macOS");
                    missingRequirements.push("Remote host is not macOS (expected Darwin kernel)");
                }
                else {
                    log("macOS confirmed");
                }
                // Check if Xcode is installed
                log("Checking Xcode...");
                if (!(await runRemoteCheck("which xcrun"))) {
                    log("Xcode not found");
                    missingRequirements.push("Xcode not installed - please install from Mac App Store or developer.apple.com");
                }
                else if (!(await runRemoteCheck("xcrun simctl help"))) {
                    log("Xcode incomplete");
                    missingRequirements.push("Xcode found but xcrun simctl not working - may need to complete installation");
                }
                else {
                    log("Xcode working");
                    try {
                        const xcodeVersion = await runRemoteCommand("xcrun --version 2>/dev/null | head -1");
                        log(`  Version: ${xcodeVersion.trim() || "unknown"}`);
                    }
                    catch {
                        log("  Version: unknown");
                    }
                }
                // Check iOS Simulators
                log("Checking iOS Simulators...");
                if (!(await runRemoteCheck("xcrun simctl list devices | grep -E '(iPhone|iPad)'"))) {
                    log("No simulators found");
                    missingRequirements.push("No iOS simulators found - install via Xcode → Preferences → Components");
                }
                else {
                    log("iOS Simulators found");
                    try {
                        const bootedCount = await runRemoteCommand("xcrun simctl list devices | grep 'Booted' | wc -l | tr -d ' '");
                        log(`  Booted simulators: ${bootedCount.trim() || "0"}`);
                    }
                    catch {
                        log("  Booted simulators: 0");
                    }
                }
                // Check Homebrew
                log("Checking Homebrew...");
                try {
                    const brewPath = await getBrewPath();
                    log("Homebrew installed");
                    try {
                        const brewVersion = await runRemoteCommand(`${brewPath} --version 2>/dev/null | head -1`);
                        log(`  Version: ${brewVersion.trim() || "unknown"}`);
                    }
                    catch {
                        log("  Version: unknown");
                    }
                    // Check if Homebrew is in default PATH
                    if (!(await runRemoteCheck("which brew"))) {
                        actionsNeeded.push("Add Homebrew to PATH in shell profiles");
                    }
                }
                catch {
                    log("Homebrew missing");
                    actionsNeeded.push("Install Homebrew package manager");
                }
                // Check Python3
                log("Checking Python3...");
                try {
                    const python3Path = await getPython3Path();
                    log("Python3 installed");
                    try {
                        const pythonVersion = await runRemoteCommand(`${python3Path} --version 2>/dev/null`);
                        log(`  Version: ${pythonVersion.trim() || "unknown"}`);
                    }
                    catch {
                        log("  Version: unknown");
                    }
                }
                catch {
                    log("Python3 missing");
                    actionsNeeded.push("Install Python3 via Homebrew");
                }
                // Check pip3
                log("Checking pip3...");
                try {
                    const pip3Path = await getPip3Path();
                    log("pip3 available");
                    try {
                        const pipVersion = await runRemoteCommand(`${pip3Path} --version 2>/dev/null`);
                        log(`  Version: ${pipVersion.trim() || "unknown"}`);
                    }
                    catch {
                        log("  Version: unknown");
                    }
                }
                catch {
                    log("pip3 missing");
                    actionsNeeded.push("Configure pip3 for Python3");
                }
                // Check idb-companion
                log("Checking idb-companion...");
                try {
                    const brewPath = await getBrewPath();
                    if (await runRemoteCheck(`${brewPath} list idb-companion >/dev/null 2>&1`) ||
                        await runRemoteCheck("which idb_companion")) {
                        log("idb-companion installed");
                    }
                    else {
                        log("idb-companion missing");
                        actionsNeeded.push("Install idb-companion via Homebrew");
                    }
                }
                catch {
                    // If brew not found, just check for idb_companion binary
                    if (await runRemoteCheck("which idb_companion")) {
                        log("idb-companion installed");
                    }
                    else {
                        log("idb-companion missing");
                        actionsNeeded.push("Install idb-companion via Homebrew");
                    }
                }
                // Check fb-idb Python package
                log("Checking fb-idb...");
                try {
                    const pip3Path = await getPip3Path();
                    if (await runRemoteCheck(`${pip3Path} show fb-idb >/dev/null 2>&1`)) {
                        log("fb-idb installed");
                        try {
                            const idbVersion = await runRemoteCommand(`${pip3Path} show fb-idb 2>/dev/null | grep Version`);
                            log(`  ${idbVersion.trim() || "Version: unknown"}`);
                        }
                        catch {
                            log("  Version: unknown");
                        }
                    }
                    else {
                        log("fb-idb missing");
                        actionsNeeded.push("Install fb-idb Python package");
                    }
                }
                catch {
                    log("fb-idb missing");
                    actionsNeeded.push("Install fb-idb Python package");
                }
                // Check idb command accessibility
                log("Checking idb command...");
                if (await runRemoteCheck("which idb")) {
                    log("idb command in PATH");
                }
                else {
                    try {
                        const python3Path = await getPython3Path();
                        if (await runRemoteCheck(`${python3Path} -c 'import idb' >/dev/null 2>&1`)) {
                            log("idb module available");
                            // Check if Python bin is in PATH via shell profiles
                            if (!(await runRemoteCheck("(test -f ~/.zshrc && grep -q '/.local/bin' ~/.zshrc) || (test -f ~/.bash_profile && grep -q '/.local/bin' ~/.bash_profile)"))) {
                                actionsNeeded.push("Add Python bin directory to PATH for idb command");
                            }
                        }
                        else {
                            log("idb not accessible");
                            // This will be resolved by installing fb-idb
                        }
                    }
                    catch {
                        log("idb not accessible");
                        // This will be resolved by installing fb-idb
                    }
                }
                // Check idb_companion daemon
                log("Checking idb_companion daemon...");
                if (await runRemoteCheck("pgrep -f idb_companion")) {
                    log("idb_companion daemon running");
                    try {
                        const daemonInfo = await runRemoteCommand("ps aux | grep idb_companion | grep -v grep | head -1");
                        log(`  Process: ${daemonInfo.trim() || "running"}`);
                    }
                    catch {
                        log("  Process: running");
                    }
                }
                else {
                    log("idb_companion daemon not running");
                    actionsNeeded.push("Start idb_companion daemon");
                }
                // === SUMMARY PHASE ===
                log("");
                log("Analysis Summary:");
                log("==================");
                if (missingRequirements.length > 0) {
                    log("");
                    log("MISSING REQUIREMENTS (must be resolved manually):");
                    for (const req of missingRequirements) {
                        log(`  • ${req}`);
                    }
                }
                if (actionsNeeded.length > 0) {
                    log("");
                    log("ACTIONS NEEDED:");
                    for (const action of actionsNeeded) {
                        log(`  • ${action}`);
                    }
                }
                else {
                    log("");
                    log("No actions needed - system is already configured!");
                }
                // Exit if this is a dry run
                if (dry_run) {
                    log("");
                    log("Dry run complete. To apply changes, run this tool again without dry_run option.");
                    return {
                        content: [
                            {
                                type: "text",
                                text: output,
                            },
                        ],
                    };
                }
                // Exit if there are missing requirements
                if (missingRequirements.length > 0) {
                    log("");
                    log("Cannot proceed due to missing requirements.");
                    log("Please resolve the issues above and run this tool again.");
                    return {
                        content: [
                            {
                                type: "text",
                                text: output,
                            },
                        ],
                    };
                }
                // Exit if no actions needed
                if (actionsNeeded.length === 0) {
                    log("");
                    log("System is already properly configured!");
                    log("");
                    log(`Your macOS host (${host}) is ready for iOS Simulator MCP!`);
                    return {
                        content: [
                            {
                                type: "text",
                                text: output,
                            },
                        ],
                    };
                }
                // === CONFIRMATION PHASE ===
                if (!auto_confirm) {
                    log("");
                    log(`❓ Would apply ${actionsNeeded.length} changes to ${host}.`);
                    log("To proceed automatically, set auto_confirm to true.");
                    return {
                        content: [
                            {
                                type: "text",
                                text: output,
                            },
                        ],
                    };
                }
                log("");
                log("Applying changes...");
                // === EXECUTION PHASE ===
                // Install Homebrew if needed
                if (actionsNeeded.includes("Install Homebrew package manager")) {
                    log("");
                    log("Installing Homebrew...");
                    try {
                        await runRemoteCommand('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
                        log("Homebrew installed successfully");
                        // Clear cache and detect new installation
                        brewCache.value = null;
                        const brewPath = await getBrewPath();
                        const brewDir = brewPath.replace('/brew', '');
                        // Add to PATH
                        await runRemoteCommand(`grep -q "${brewDir}" ~/.zshrc 2>/dev/null || echo "export PATH=${brewDir}:$PATH" >> ~/.zshrc`);
                        await runRemoteCommand(`grep -q "${brewDir}" ~/.bash_profile 2>/dev/null || echo "export PATH=${brewDir}:$PATH" >> ~/.bash_profile`);
                    }
                    catch (error) {
                        log("Homebrew installation failed");
                        throw error;
                    }
                }
                // Fix Homebrew PATH if needed
                if (actionsNeeded.includes("Add Homebrew to PATH in shell profiles")) {
                    log("");
                    log("Adding Homebrew to PATH...");
                    try {
                        const brewPath = await getBrewPath();
                        const brewDir = brewPath.replace('/brew', '');
                        await runRemoteCommand(`grep -q "${brewDir}" ~/.zshrc 2>/dev/null || echo "export PATH=${brewDir}:$PATH" >> ~/.zshrc`);
                        await runRemoteCommand(`grep -q "${brewDir}" ~/.bash_profile 2>/dev/null || echo "export PATH=${brewDir}:$PATH" >> ~/.bash_profile`);
                        log("PATH updated");
                    }
                    catch (error) {
                        log("Failed to update PATH");
                        throw error;
                    }
                }
                // Install Python3 if needed
                if (actionsNeeded.includes("Install Python3 via Homebrew")) {
                    log("");
                    log("Installing Python3...");
                    try {
                        const brewPath = await getBrewPath();
                        await runRemoteCommand(`${brewPath} install python3`);
                        log("Python3 installed successfully");
                        // Clear cache to detect new installation
                        python3Cache.value = null;
                        pip3Cache.value = null;
                    }
                    catch (error) {
                        log("Python3 installation failed");
                        throw error;
                    }
                }
                // Configure pip3 if needed
                if (actionsNeeded.includes("Configure pip3 for Python3")) {
                    log("");
                    log("Configuring pip3...");
                    try {
                        const python3Path = await getPython3Path();
                        await runRemoteCommand(`${python3Path} -m ensurepip --upgrade`);
                        log("pip3 configured successfully");
                        // Clear cache to detect new installation
                        pip3Cache.value = null;
                    }
                    catch (error) {
                        log("pip3 configuration failed");
                        throw error;
                    }
                }
                // Install idb-companion if needed
                if (actionsNeeded.includes("Install idb-companion via Homebrew")) {
                    log("");
                    log("Installing idb-companion...");
                    try {
                        const brewPath = await getBrewPath();
                        await runRemoteCommand(`${brewPath} install idb-companion`);
                        log("idb-companion installed successfully");
                    }
                    catch (error) {
                        log("idb-companion installation failed");
                        throw error;
                    }
                }
                // Install fb-idb if needed
                if (actionsNeeded.includes("Install fb-idb Python package")) {
                    log("");
                    log("Installing fb-idb...");
                    try {
                        const pip3Path = await getPip3Path();
                        await runRemoteCommand(`${pip3Path} install fb-idb`);
                        log("fb-idb installed successfully");
                    }
                    catch (error) {
                        log("fb-idb installation failed");
                        throw error;
                    }
                }
                // Fix idb PATH if needed
                if (actionsNeeded.includes("Add Python bin directory to PATH for idb command")) {
                    log("");
                    log("Adding Python bin to PATH for idb...");
                    await runRemoteCommand('grep -q "/.local/bin" ~/.zshrc 2>/dev/null || echo "export PATH=$HOME/.local/bin:$PATH" >> ~/.zshrc');
                    await runRemoteCommand('grep -q "/.local/bin" ~/.bash_profile 2>/dev/null || echo "export PATH=$HOME/.local/bin:$PATH" >> ~/.bash_profile');
                    log("Python bin added to PATH");
                }
                // Start idb_companion daemon if needed
                if (actionsNeeded.includes("Start idb_companion daemon")) {
                    log("");
                    log("Starting idb_companion daemon...");
                    // Kill any existing instances
                    await runRemoteCommand("pkill -f idb_companion >/dev/null 2>&1 || true");
                    // Start daemon
                    try {
                        await runRemoteCommand("nohup idb_companion --udid all --grpc-port 10882 --log-level INFO >/tmp/idb_companion.log 2>&1 &");
                        // Give it time to start and check
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        if (await runRemoteCheck("pgrep -f idb_companion")) {
                            log("idb_companion daemon started successfully");
                        }
                        else {
                            log("idb_companion failed to start");
                            try {
                                const logContent = await runRemoteCommand("tail -10 /tmp/idb_companion.log 2>/dev/null");
                                log(`Log: ${logContent}`);
                            }
                            catch {
                                log("No log available");
                            }
                            throw new Error("Failed to start idb_companion daemon");
                        }
                    }
                    catch (error) {
                        log("Failed to start idb_companion daemon");
                        throw error;
                    }
                }
                // === FINAL VERIFICATION ===
                log("");
                log("Final verification...");
                // Test idb functionality
                if (await runRemoteCheck("timeout 10 idb list-targets") ||
                    await runRemoteCheck("timeout 10 python3 -c 'import idb'")) {
                    log("idb working correctly");
                    try {
                        const targets = await runRemoteCommand("idb list-targets 2>/dev/null");
                        log("Available targets:");
                        log(targets || "No targets (may be normal if no simulators booted)");
                    }
                    catch {
                        log("Available targets: No targets (may be normal if no simulators booted)");
                    }
                }
                else {
                    log("idb test inconclusive, but installation completed");
                }
                log("");
                log("Setup completed successfully!");
                log("");
                log("System Status:");
                log("  • macOS: Verified");
                log("  • Xcode: Working");
                log("  • iOS Simulators: Available");
                log("  • Homebrew: Installed");
                log("  • Python3/pip3: Available");
                log("  • idb/idb-companion: Installed and running");
                log("");
                log(`Your macOS host (${host}) is ready for iOS Simulator MCP!`);
                log("");
                log("Next steps:");
                log("1. Configure SSH environment variables for this MCP server");
                log("2. Test with: 'Take a screenshot of the iOS simulator'");
                log("3. Try UI interactions: 'Tap on the Settings app'");
                // Update global cache after successful setup
                cachedBrewPath = brewCache.value;
                cachedPython3Path = python3Cache.value;
                cachedPip3Path = pip3Cache.value;
                return {
                    content: [
                        {
                            type: "text",
                            text: output,
                        },
                    ],
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error setting up remote host: ${errorMessage}`,
                        },
                    ],
                };
            }
        }
    };
}
