# tshell

tshell is a lightweight SSH and SFTP extension for Visual Studio Code.

It helps you manage Linux servers, open interactive shell sessions, and transfer files or folders from a simple VS Code interface. tshell only uses standard client-side SSH/SFTP. It does not install software, upload helper scripts, or modify the remote Linux server.

## Key Features

- Manage Linux servers in groups from the tshell activity bar.
- Add, edit, rename, and delete server groups.
- Add, edit, and delete server configurations.
- Store all groups, servers, language, and file-transfer options in `tshell.config.json`.
- Support password login and private key login.
- Save passwords and private key passphrases as encrypted values in the config file.
- Run interactive terminal sessions with xterm.js.
- Support common terminal programs and ANSI output, including `vi`, `top`, and `clear`.
- Select terminal text to copy immediately, and right-click the terminal to paste clipboard text.
- Duplicate and rename terminal sessions from the terminal tab context menu.
- Open visual SFTP file transfer pages beside the terminal.
- Upload and download files or folders, including multi-select transfers.
- Browse remote folders by double-clicking folders or typing a path and pressing Enter.
- Browse local Windows drive roots such as `C:` and `D:` in the built-in upload picker.
- View file size and last modified time in the file transfer page.
- Keep detailed upload/download logs, including each file inside transferred folders.
- Preview remote files as text with line numbers, syntax highlighting, and UTF-8/GB2312 encoding selection.
- Preview CSV and DBF files as tables with row numbers.
- Load large text and DBF previews progressively while scrolling.
- Restore terminal output/status and transfer logs when VS Code reloads a webview after moving or copying it to another window.
- Support English and Chinese UI text.

## Quick Start

1. Open the tshell activity bar item in VS Code.
2. Click the `+` button to add a group, or use the default group.
3. Add a server under a group.
4. Choose `Password` or `Private Key` authentication.
5. Double-click the server to open a terminal session.
6. Click `File Transfer` in the terminal toolbar to open the SFTP transfer page.

## Server Manager

The server manager is shown in the tshell activity bar view.

Available actions:

- Click `+` in the top toolbar to add a group.
- Click the settings button in the top toolbar to open `tshell.config.json`.
- Use group action icons to add a server, rename the group, or delete the group.
- Use server action icons to edit or delete a server.
- Right-click blank space to add a group.
- Right-click a group to add a group, rename/delete the group, or add a server.
- Right-click a server to edit or delete it.
- Double-click a server to connect.

## Authentication

tshell supports two SSH authentication modes.

### Password Login

Choose `Password` in the server editor.

- If you enter a password, tshell saves it as `encryptedPassword`.
- If you leave the password empty, tshell asks for it when connecting.

### Private Key Login

Choose `Private Key` in the server editor.

Required:

- `privateKeyPath`: local private key file path, for example `C:\Users\you\.ssh\id_rsa` or `~/.ssh/id_rsa`.

Optional:

- Private key passphrase. If entered, tshell saves it as `encryptedPrivateKeyPassphrase`.

Passwordless private keys are supported and do not require a login prompt.

## Terminal Usage

Each connected server opens in an xterm-based terminal page.

Supported terminal behavior:

- Interactive shell input and output.
- ANSI colors and terminal control sequences.
- `clear` clears the visible terminal.
- Interactive commands such as `top` and editors such as `vi`.
- Press Enter after a disconnect to try reconnecting.
- Select text to copy it immediately.
- Right-click the terminal content area to paste clipboard text at the cursor.
- Right-click the terminal tab header to copy the session or rename the session.

Duplicated sessions open in the same editor group as the current terminal. New session titles are numbered automatically, such as `server`, `server(1)`, and `server(2)`.

## File Transfer

Click `File Transfer` in a terminal page to open the SFTP transfer page beside the terminal.

The file transfer page supports:

- Path entry: type a remote path and press Enter.
- Refresh current remote folder.
- Double-click folders to enter them.
- Select one or more remote files/folders.
- Download selected remote files/folders.
- Upload local files/folders through the built-in picker.
- Browse Windows drive roots in the upload picker.
- Reconnect by pressing Enter in the path field or clicking Refresh after a disconnect.
- Review detailed operation logs.
- Drag the log divider to show more or fewer log lines.
- Right-click the operation log to copy log text.

Opening file transfer multiple times for the same server creates numbered tabs, for example:

- `File Transfer - dev`
- `File Transfer - dev(1)`
- `File Transfer - dev(2)`

## File Preview

Double-click a remote file in the file transfer page to preview it.

Preview features:

- All files can be opened for preview.
- Text files are shown as text.
- Binary files show an unsupported preview message.
- Each preview starts from the top.
- UTF-8 and GB2312 preview encodings are selectable in the preview toolbar.
- Preview font size can be adjusted.
- Large text files load progressively while scrolling.
- Common code/config formats have syntax highlighting.
- CSV files support text preview and table preview.
- DBF files support progressive table preview.
- CSV and DBF table previews include row numbers.

Common highlighted extensions include:

`.c`, `.cpp`, `.h`, `.hpp`, `.java`, `.js`, `.ts`, `.json`, `.xml`, `.html`, `.css`, `.sh`, `.py`, `.txt`, `.ini`, `.conf`, `.cfg`, `.properties`, `.env`, `.csv`, and `.dbf`.

## Config File

Open the config file from:

- the settings button in the tshell sidebar, or
- the command palette command `tshell: Open Config File`.

The file is named `tshell.config.json` and is stored in VS Code's extension global storage directory.

Example:

```json
{
  "settings": {
    "language": "en-US",
    "showHiddenFiles": false
  },
  "groups": [
    {
      "id": "default",
      "name": "Default Group",
      "servers": [
        {
          "id": "server-password",
          "name": "dev-password",
          "host": "10.0.1.168",
          "port": 22,
          "username": "stock",
          "authType": "password",
          "encoding": "gb18030",
          "encryptedPassword": "enc:v1:..."
        },
        {
          "id": "server-key",
          "name": "dev-key",
          "host": "10.0.1.169",
          "port": 22,
          "username": "ubuntu",
          "authType": "privateKey",
          "privateKeyPath": "C:\\Users\\you\\.ssh\\id_rsa",
          "encryptedPrivateKeyPassphrase": "enc:v1:...",
          "encoding": "utf-8"
        }
      ]
    }
  ]
}
```

## Config Options

| Path | Type | Required | Supported values | Description |
| --- | --- | --- | --- | --- |
| `settings.language` | string | No | `en-US`, `zh-CN` | UI language. Defaults to `en-US`. |
| `settings.showHiddenFiles` | boolean | No | `true`, `false` | Whether remote and local file lists show hidden files/folders. Defaults to `false`. |
| `groups` | array | Yes | Group objects | Server groups shown in the tshell tree view. |
| `groups[].id` | string | Yes | Unique string | Stable group ID. |
| `groups[].name` | string | Yes | Any display name | Group display name. |
| `groups[].servers` | array | Yes | Server objects | Servers inside the group. |
| `groups[].servers[].id` | string | Yes | Unique string | Stable server ID. |
| `groups[].servers[].name` | string | No | Any display name | Server display name. If empty, the host is used. |
| `groups[].servers[].host` | string | Yes | Hostname or IP address | Linux SSH server host. |
| `groups[].servers[].port` | number | No | `1`-`65535` | SSH port. Defaults to `22`. |
| `groups[].servers[].username` | string | Yes | Linux username | SSH login user. |
| `groups[].servers[].authType` | string | No | `password`, `privateKey` | SSH authentication type. Defaults to `password`, or `privateKey` when `privateKeyPath` is set. |
| `groups[].servers[].encoding` | string | No | `utf-8`, `gb18030` | Terminal input/output encoding. Use `gb18030` for GB2312/GBK-style Chinese output. Defaults to `utf-8`. |
| `groups[].servers[].encryptedPassword` | string | No | `enc:v1:...` | Encrypted password generated by tshell. Omit it to prompt for a password when connecting. |
| `groups[].servers[].privateKeyPath` | string | Required for private key login | Local file path | Local private key path. `~` is supported. |
| `groups[].servers[].encryptedPrivateKeyPassphrase` | string | No | `enc:v1:...` | Optional encrypted private key passphrase generated by tshell. |

## Notes

- tshell never writes plaintext passwords or private key passphrases to the config file.
- Use the server editor UI to generate encrypted password/passphrase values.
- Do not manually write plaintext secrets into `tshell.config.json`.
- File preview encoding is selected in the preview toolbar and is not stored in the config file.
- tshell only uses client-side SSH/SFTP and does not modify the Linux server.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an extension development host.
