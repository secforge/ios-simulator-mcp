# iOS Simulator MCP - TROUBLESHOOTING

If you encounter errors or issues using this MCP server, try the following troubleshooting steps before reporting a bug:

## 1. Prerequisites

### Local Setup (macOS)
- **macOS:** Direct usage requires macOS with Xcode and iOS simulators installed.
- **IDB Tool:** Ensure [Facebook IDB](https://fbidb.io/) is installed and available in your PATH.
- **Node.js:** Make sure Node.js is installed and up to date.

### Remote Setup (SSH from WSL/Linux)
- **macOS Host:** A macOS machine with Xcode and iOS simulators installed.
- **SSH Access:** SSH connectivity to the macOS host.
- **Remote IDB:** IDB installed on the macOS host (auto-detected or configurable via `IOS_SIMULATOR_IDB_PATH`).
- **Local Node.js:** Node.js installed on your WSL/Linux system.

## 2. Installing IDB 

The installation section in [IDB](https://fbidb.io/docs/installation/) is a little out of date. Since [python environments are famously borked](https://xkcd.com/1987/), here are some ways to install that are hopefully compatible with your existing python install.

### Using Homebrew + pip

1. Install [Homebrew](https://brew.sh/) if you don't have it:
   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. Install Python (if not already installed):
   ```sh
   brew install python
   ```
3. Install idb using pip:
   ```sh
   pip3 install --user fb-idb
   ```
4. Ensure your user base binary directory is in your PATH (often `~/.local/bin`):
   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   # Add the above line to your ~/.zshrc or ~/.bash_profile for persistence
   ```
5. Verify installation:
   ```sh
   idb --version
   ```

### Using asdf (Python version manager)

1. Install [asdf](https://asdf-vm.com/):
   ```sh
   brew install asdf
   ```
2. Add the [Python plugin](https://github.com/asdf-community/asdf-python) and install Python:
   ```sh
   asdf plugin add python
   asdf install python latest
   asdf global python latest
   ```
3. Install idb using pip:
   ```sh
   pip install --user fb-idb
   ```
4. Ensure your user base binary directory is in your PATH (often `~/.local/bin`):
   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   # Add the above line to your ~/.zshrc or ~/.bash_profile for persistence
   ```
5. Verify installation:
   ```sh
   idb --version
   ```

## 3. Common Issues & Fixes

### "No booted simulator found"
- Open Xcode and boot an iOS simulator manually.
- Run `xcrun simctl list devices` to verify a simulator is booted.

### "idb: command not found" or IDB errors

#### Local Setup:
- Follow the install steps above for Homebrew + pip or asdf.
- Ensure `idb` is in your PATH: try running `idb --version` in your terminal.

#### SSH Setup:
- Ensure IDB is installed on the macOS host (use `setup-remote-macos.sh` script).
- The MCP server auto-detects IDB location on the remote host.
- If auto-detection fails, set `IOS_SIMULATOR_IDB_PATH` environment variable to the full path.
- Test SSH connection: `ssh user@host "idb --version"`

### Permission or File Errors

#### Local Setup:
- Ensure you have permission to write to the output path (e.g., for screenshots or recordings).
- Files are saved to `~/Downloads` by default, or system temp directory if Downloads doesn't exist.
- Try using an absolute path if you encounter permission issues.

#### SSH Setup:
- Screenshots and videos are automatically downloaded from the remote host to your local system.
- Ensure you have write permissions to the local output directory.
- Remote temporary files are automatically cleaned up after download.

### Simulator UI Not Responding
- Restart the simulator and try again.
- Quit and relaunch Xcode if needed.
- Use the new simulator control tools: `simulator_restart`, `simulator_stop`, `simulator_start`.
- Prompt AI to check dimensions of the simulator screen and adjust coordinates to it. Screenshots have 3x resolution and this may result in incorrect position of screen presses.

### SSH Connection Issues
- **Connection Refused:** Verify SSH service is running on macOS host and firewall allows connections.
- **Authentication Failed:** Ensure SSH keys are properly set up or use password authentication.
- **Command Timeout:** Check network connectivity and SSH_PORT configuration.
- **Permission Denied:** Verify user has permission to run `xcrun` and `idb` commands on macOS host.

## 4. Still Stuck?
- Check the [README](./README.md) for setup and usage instructions.
- If the problem persists, [open an issue](https://github.com/joshuayoes/ios-simulator-mcp/issues) and include the error message and steps to reproduce.

