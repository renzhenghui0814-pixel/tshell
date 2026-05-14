# tshell

A lightweight VS Code extension for managing Linux SSH servers, running interactive commands, and transferring files with SFTP.

The extension only uses standard SSH and SFTP from the VS Code client side. It does not install software, upload helper scripts, or modify the Linux server.

## Features

- Manage saved Linux servers in groups.
- Add, edit, delete, and rename server groups.
- Add, edit, and delete server configs.
- Use compact icon actions and right-click menus in the server manager. Right-click blank space to add a group, right-click a group to manage groups or add a server, and right-click a server to edit or delete it.
- Password login and private key login.
- Server config includes host, port, user, authentication type, optional encrypted password, optional private key path/passphrase, and input/output encoding.
- Store groups, servers, language, and file-transfer settings in `tshell.config.json`.
- Configure Chinese/English UI and hidden file visibility from the JSON config file.
- Open a server by double-clicking it in the SSH sidebar.
- Use an xterm-based terminal page that supports ANSI colors, `clear`, `top`, and other interactive shell output.
- Select terminal text to copy it immediately, and right-click the terminal to paste clipboard text at the cursor.
- Copy an active terminal session into a new tab in the same editor group.
- Open a visual file transfer page from the terminal toolbar.
- Browse remote folders, type a path and press Enter, refresh the current path, upload files/folders with the built-in local picker, and download files/folders.
- Browse Windows drive roots such as `C:` and `D:` in the built-in upload picker.
- Select multiple remote files/folders and download them in one operation.
- Download selected remote entries from the toolbar instead of per-row buttons.
- Preview common remote text files in the file transfer page with line numbers, basic syntax highlighting, and UTF-8/GB2312 preview encoding selection.
- Preview CSV and DBF files as tables with row numbers. DBF previews load progressively while scrolling.
- Open each file preview from the top instead of restoring the previous preview scroll position.
- Review upload/download history in the resizable file transfer operation log, including each file inside uploaded or downloaded folders.
- Copy operation log text from a copy-only context menu.
- Retry SSH/SFTP connections from the terminal with Enter or from the file transfer page with Refresh/path Enter after a disconnect.
- Show remote file size and last modified time.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code or run the extension development host to test.

## Config File

Open the config from the command palette with **tshell: Open Config File**, or from the tshell view title menu. The file is named `tshell.config.json` and is stored in the extension global storage directory managed by VS Code.

Passwords entered in the UI are saved as ciphertext in `encryptedPassword`. You can also omit `encryptedPassword`; tshell will prompt for the login password when connecting.

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
          "id": "server-1",
          "name": "dev",
          "host": "10.0.1.168",
          "port": 22,
          "username": "stock",
          "authType": "password",
          "encoding": "gb18030",
          "encryptedPassword": "enc:v1:..."
        },
        {
          "id": "server-2",
          "name": "key-login",
          "host": "10.0.1.169",
          "port": 22,
          "username": "ubuntu",
          "authType": "privateKey",
          "privateKeyPath": "C:\\Users\\you\\.ssh\\id_rsa",
          "encoding": "utf-8"
        }
      ]
    }
  ]
}
```

### Supported Options

| Path | Type | Required | Supported values | Description |
| --- | --- | --- | --- | --- |
| `settings.language` | string | No | `en-US`, `zh-CN` | UI language. Defaults to `en-US`. Changes take effect after the view reloads or the extension UI is reopened. |
| `settings.showHiddenFiles` | boolean | No | `true`, `false` | Whether file transfer lists hidden files/folders. Defaults to `false`. |
| `groups` | array | Yes | Array of group objects | Server groups shown in the tshell tree view. |
| `groups[].id` | string | Yes | Any unique string | Stable group ID. Use a unique value. |
| `groups[].name` | string | Yes | Any display name | Group name shown in the sidebar. |
| `groups[].servers` | array | Yes | Array of server objects | Servers under this group. |
| `groups[].servers[].id` | string | Yes | Any unique string | Stable server ID. Use a unique value. |
| `groups[].servers[].name` | string | No | Any display name | Server display name. If empty, the host is used. |
| `groups[].servers[].host` | string | Yes | Hostname or IP address | Linux SSH server host. |
| `groups[].servers[].port` | number | No | `1`-`65535` | SSH port. Defaults to `22`. |
| `groups[].servers[].username` | string | Yes | Linux username | SSH login user. |
| `groups[].servers[].authType` | string | No | `password`, `privateKey` | SSH authentication type. Defaults to `password`, or `privateKey` when `privateKeyPath` is set. |
| `groups[].servers[].encoding` | string | No | `utf-8`, `gb18030` | Terminal input/output encoding. Use `gb18030` for GB2312/GBK-like Chinese server output. Defaults to `utf-8`. |
| `groups[].servers[].encryptedPassword` | string | No | `enc:v1:...` | Encrypted password generated by tshell. Omit this field to be prompted for a password when connecting. |
| `groups[].servers[].privateKeyPath` | string | No | Local file path | Local private key path for `privateKey` authentication. `~` is supported. |
| `groups[].servers[].encryptedPrivateKeyPassphrase` | string | No | `enc:v1:...` | Optional encrypted passphrase for encrypted private keys. Omit for passwordless private keys. |

### Notes

- Do not write plaintext passwords or private key passphrases into the JSON file. Add or edit the server from the UI if you want tshell to generate encrypted values.
- File preview encoding is selected in the file transfer preview toolbar (`UTF-8` or `GB2312`) and is not stored in the JSON config.
- The extension uses only client-side SSH/SFTP. It does not upload scripts, install software, or modify the Linux server.
