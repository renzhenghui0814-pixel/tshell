# Changelog

## 0.1.6

- Move the config file action from the VS Code view title menu into the tshell sidebar as a compact settings button.
- Restore terminal status and recent output when a terminal webview is moved or copied to another VS Code window.
- Restore file transfer operation logs when a transfer webview is moved or copied to another VS Code window.
- Open file transfer pages beside the terminal and auto-number duplicate transfer tabs for the same server.

## 0.1.5

- Improve terminal copy and paste behavior: selecting terminal text now copies it immediately, and right-click pastes clipboard text at the cursor.
- Restrict context menus by area so terminal toolbar/file lists do not show unnecessary menus.
- Keep terminal session copy in the current editor group instead of opening a side-by-side split.
- Replace the server row triangle marker with a compact server icon.
- Add a copy-only context menu for the file transfer operation log.

## 0.1.4

- Support private key SSH login, including optional encrypted private key passphrases.
- Clarify server action tooltips as "Edit Server" and "Delete Server".
- Reset file previews to the top every time a file is opened.

## 0.1.3

- Add DBF file preview with progressive table loading.
- Add row numbers to CSV and DBF table previews.
- Improve the server manager with compact icon actions and right-click menus for blank areas, groups, and servers.
- Hide encoding text from server rows to keep the server list cleaner.
- Fix terminal layout sizing so the last line is not hidden at the bottom of the page.

## 0.1.2

- Add Marketplace icon.

## 0.1.1

- Manage SSH servers with groups in the tshell activity bar.
- Store groups, servers, language, and file-transfer options in `tshell.config.json`.
- Support password-based SSH login with encrypted saved passwords or prompt-on-connect passwords.
- Run interactive Linux shell sessions in xterm.js, including `vi`, `top`, `clear`, ANSI output, reconnect, and duplicate sessions.
- Rename terminal session tabs and auto-name copied sessions with suffixes such as `(1)` and `(2)`.
- Browse remote folders over SFTP with path entry, refresh, size, and last modified time.
- Upload and download files or folders, including multi-select transfers and detailed operation logs.
- Preview remote files in-page as text, detect binary files, and load large previews progressively while scrolling.
- Support syntax highlighting for common source/config formats and CSV text/table preview switching.
- Support UTF-8 and GB2312 preview encodings.
- Support Chinese/English UI text and VS Code command localization.

## 0.1.0

- Initial release of tshell.
- SSH terminal sessions with password login.
- SFTP file and folder upload/download.
- Grouped server configuration stored in JSON.
- Chinese/English UI configured through JSON.
