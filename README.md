# tshell

A lightweight VS Code extension for managing Linux SSH servers, running interactive commands, and transferring files with SFTP.

The extension only uses standard SSH and SFTP from the VS Code client side. It does not install software, upload helper scripts, or modify the Linux server.

## Features

- Manage saved Linux servers in groups.
- Add, edit, delete, and rename server groups.
- Add, edit, and delete server configs.
- Password login only, by design for the current simplified version.
- Server config includes host, port, user, optional encrypted password, and input/output encoding.
- Store groups, servers, language, and file-transfer settings in `tshell.config.json`.
- Configure Chinese/English UI and hidden file visibility from the JSON config file.
- Open a server by double-clicking it in the SSH sidebar.
- Use an xterm-based terminal page that supports ANSI colors, `clear`, `top`, and other interactive shell output.
- Open a visual file transfer page from the terminal toolbar.
- Browse remote folders, type a path and press Enter, refresh the current path, upload files/folders with the built-in local picker, and download files/folders.
- Browse Windows drive roots such as `C:` and `D:` in the built-in upload picker.
- Select multiple remote files/folders and download them in one operation.
- Download selected remote entries from the toolbar instead of per-row buttons.
- Review upload/download history in the resizable file transfer operation log, including each file inside uploaded or downloaded folders.
- Retry SSH/SFTP connections from the terminal with Enter or from the file transfer page with Refresh/path Enter after a disconnect.
- Show remote file size and last modified time.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code or run the extension development host to test.

## Config File

Open the config from the command palette with **tshell: Open Config File**, or from the tshell view title menu. Passwords entered in the UI are saved as ciphertext in the JSON file.

```json
{
  "settings": {
    "language": "en-US",
    "showHiddenFiles": false
  },
  "groups": [
    {
      "id": "default",
      "name": "默认分组",
      "servers": [
        {
          "id": "server-1",
          "name": "dev",
          "host": "10.0.1.168",
          "port": 22,
          "username": "stock",
          "encoding": "gb18030",
          "encryptedPassword": "enc:v1:..."
        }
      ]
    }
  ]
}
```
