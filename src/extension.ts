import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import * as iconv from 'iconv-lite';

type TerminalEncoding = 'utf-8' | 'gb18030';
type PreviewEncoding = 'utf8' | 'gb2312';
type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';
type Language = 'zh-CN' | 'en-US';
type AuthType = 'password' | 'privateKey';

interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  encoding: TerminalEncoding;
  authType: AuthType;
  encryptedPassword?: string;
  privateKeyPath?: string;
  encryptedPrivateKeyPassphrase?: string;
}

interface ResolvedAuth {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

interface ServerGroup {
  id: string;
  name: string;
  servers: ServerConfig[];
}

interface RemoteEntry {
  name: string;
  path: string;
  type: RemoteEntryType;
  size: number;
  modifiedAt: number;
}

interface DownloadRequestItem {
  path: string;
  isDirectory: boolean;
}

interface LocalEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

interface TextPreviewResult {
  content: string;
  binary: boolean;
  done: boolean;
  nextOffset: number;
  size: number;
}

interface DbfField {
  name: string;
  type: string;
  length: number;
  decimalCount: number;
}

interface DbfPreviewResult {
  fields: DbfField[];
  rows: string[][];
  recordCount: number;
  nextRecord: number;
  done: boolean;
}

interface AppSettings {
  language: Language;
  showHiddenFiles: boolean;
}

interface AppConfig {
  settings: AppSettings;
  groups: ServerGroup[];
}

interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}

const defaultGroupId = 'default';
const configFileName = 'tshell.config.json';
const legacyConfigFileName = 'simple-ssh-manager.config.json';

export function activate(context: vscode.ExtensionContext) {
  const manager = new ServerManagerViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ServerManagerViewProvider.viewType, manager, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('tshell.focus', () => {
      vscode.commands.executeCommand('workbench.view.extension.tshell');
    }),
    vscode.commands.registerCommand('tshell.openConfig', async () => {
      const store = new ConfigStore(context);
      await store.load();
      await vscode.window.showTextDocument(vscode.Uri.file(store.configPath));
    }),
    vscode.commands.registerCommand('tshell.copySession', () => {
      TerminalPage.copyActiveSession();
    }),
    vscode.commands.registerCommand('tshell.renameSession', () => {
      void TerminalPage.renameActiveSession();
    }),
    vscode.commands.registerCommand('tshell.openTransfer', () => {
      TerminalPage.openActiveTransfer();
    })
  );
}

export function deactivate() {
  // Sessions are owned by their WebviewPanel disposables.
}

class ConfigStore {
  readonly configPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configPath = path.join(context.globalStorageUri.fsPath, configFileName);
  }

  async load(): Promise<AppConfig> {
    await fs.promises.mkdir(path.dirname(this.configPath), { recursive: true });
    await this.migrateLegacyConfig();
    try {
      const raw = await fs.promises.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const config = normalizeConfig(parsed);
      let changed = false;
      for (const group of config.groups) {
        for (const server of group.servers) {
          const legacyPassword = (server as unknown as { password?: string }).password;
          if (legacyPassword && !server.encryptedPassword) {
            server.encryptedPassword = this.encryptPassword(legacyPassword);
            delete (server as unknown as { password?: string }).password;
            changed = true;
          }
          if (server.encryptedPassword) {
            const password = this.decryptPassword(server.encryptedPassword);
            if (password) {
              const normalizedPassword = this.encryptPassword(password);
              if (normalizedPassword !== server.encryptedPassword) {
                server.encryptedPassword = normalizedPassword;
                changed = true;
              }
            }
          }
          if (server.encryptedPrivateKeyPassphrase) {
            const passphrase = this.decryptPassword(server.encryptedPrivateKeyPassphrase);
            if (passphrase) {
              const normalizedPassphrase = this.encryptPassword(passphrase);
              if (normalizedPassphrase !== server.encryptedPrivateKeyPassphrase) {
                server.encryptedPrivateKeyPassphrase = normalizedPassphrase;
                changed = true;
              }
            }
          }
        }
      }
      if (changed) {
        await this.save(config);
      }
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        void vscode.window.showWarningMessage(`tshell config reset: ${(error as Error).message}`);
      }
      const config = defaultConfig();
      await this.save(config);
      return config;
    }
  }

  async save(config: AppConfig): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.promises.writeFile(this.configPath, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
  }

  encryptPassword(password: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decryptPassword(value: string): string {
    return this.decryptPasswordWithKey(value, this.key()) || this.decryptPasswordWithKey(value, this.legacyKey());
  }

  private decryptPasswordWithKey(value: string, key: Buffer): string {
    try {
      const parts = value.split(':');
      if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
        return '';
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64'));
      decipher.setAuthTag(Buffer.from(parts[3], 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  private key(): Buffer {
    return crypto.createHash('sha256').update(`${vscode.env.machineId}:tshell:v1`).digest();
  }

  private legacyKey(): Buffer {
    return crypto.createHash('sha256').update(`${vscode.env.machineId}:simple-ssh-manager:v1`).digest();
  }

  private async migrateLegacyConfig(): Promise<void> {
    const legacyPath = path.join(this.context.globalStorageUri.fsPath, legacyConfigFileName);
    try {
      await fs.promises.access(this.configPath);
    } catch {
      try {
        await fs.promises.copyFile(legacyPath, this.configPath);
      } catch {
        // No legacy config exists.
      }
    }
  }
}

class ServerManagerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'tshell.view';

  private view?: vscode.WebviewView;
  private readonly configStore: ConfigStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.configStore = new ConfigStore(context);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    void this.postState();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      const config = await this.configStore.load();
      const groups = config.groups;
      switch (message.type) {
        case 'updateSettings':
          config.settings = normalizeSettings({ ...config.settings, ...(message.settings as Partial<AppSettings>) });
          await this.configStore.save(config);
          break;
        case 'requestAddGroup':
          await this.requestAddGroup(config);
          break;
        case 'addGroup':
          groups.push({ id: makeId(), name: safeString(message.name, t(config.settings.language, 'newGroup')), servers: [] });
          await this.configStore.save(config);
          break;
        case 'requestRenameGroup':
          await this.requestRenameGroup(config, String(message.groupId));
          break;
        case 'renameGroup':
          this.findGroup(groups, String(message.groupId)).name = safeString(message.name, t(config.settings.language, 'unnamedGroup'));
          await this.configStore.save(config);
          break;
        case 'requestDeleteGroup':
          await this.requestDeleteGroup(config, String(message.groupId));
          break;
        case 'deleteGroup':
          await this.deleteGroup(config, String(message.groupId));
          break;
        case 'requestDeleteServer':
          await this.requestDeleteServer(config, String(message.groupId), String(message.serverId));
          break;
        case 'addServer':
          await this.addServer(config, String(message.groupId), message.server as Partial<ServerConfig>, String(message.password ?? ''), String(message.privateKeyPassphrase ?? ''));
          break;
        case 'updateServer':
          await this.updateServer(config, String(message.groupId), message.server as Partial<ServerConfig>, String(message.password ?? ''), String(message.privateKeyPassphrase ?? ''));
          break;
        case 'deleteServer':
          await this.deleteServer(config, String(message.groupId), String(message.serverId));
          break;
        case 'openTerminal':
          await this.openTerminal(config, String(message.groupId), String(message.serverId));
          break;
        case 'openConfig':
          await vscode.window.showTextDocument(vscode.Uri.file(this.configStore.configPath));
          break;
      }
      await this.postState();
    } catch (error) {
      this.reportError(error);
    }
  }

  private findGroup(groups: ServerGroup[], groupId: string): ServerGroup {
    const group = groups.find((item) => item.id === groupId);
    if (!group) {
      throw new Error('Group not found.');
    }
    return group;
  }

  private findServer(group: ServerGroup, serverId: string): ServerConfig {
    const server = group.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error('Server not found.');
    }
    return server;
  }

  private async addServer(config: AppConfig, groupId: string, input: Partial<ServerConfig>, password: string, privateKeyPassphrase: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    const server = normalizeServer({ ...input, id: makeId() });
    if (server.authType === 'password' && password) {
      server.encryptedPassword = this.configStore.encryptPassword(password);
    }
    if (server.authType === 'privateKey') {
      this.validatePrivateKeyServer(config.settings.language, server);
      if (privateKeyPassphrase) {
        server.encryptedPrivateKeyPassphrase = this.configStore.encryptPassword(privateKeyPassphrase);
      }
    }
    group.servers.push(server);
    await this.configStore.save(config);
  }

  private async updateServer(config: AppConfig, groupId: string, input: Partial<ServerConfig>, password: string, privateKeyPassphrase: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    const index = group.servers.findIndex((item) => item.id === input.id);
    if (index < 0) {
      throw new Error('Server not found.');
    }
    const existing = group.servers[index];
    const next = normalizeServer({ ...existing, ...input, id: existing.id });
    if (next.authType === 'password') {
      next.encryptedPassword = password ? this.configStore.encryptPassword(password) : undefined;
      next.privateKeyPath = undefined;
      next.encryptedPrivateKeyPassphrase = undefined;
    } else {
      this.validatePrivateKeyServer(config.settings.language, next);
      next.encryptedPassword = undefined;
      next.encryptedPrivateKeyPassphrase = privateKeyPassphrase ? this.configStore.encryptPassword(privateKeyPassphrase) : undefined;
    }
    group.servers[index] = next;
    await this.configStore.save(config);
  }

  private validatePrivateKeyServer(language: Language, server: ServerConfig): void {
    if (server.authType === 'privateKey' && !server.privateKeyPath) {
      throw new Error(t(language, 'privateKeyRequired'));
    }
  }

  private async deleteServer(config: AppConfig, groupId: string, serverId: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    group.servers = group.servers.filter((item) => item.id !== serverId);
    await this.configStore.save(config);
  }

  private async requestAddGroup(config: AppConfig): Promise<void> {
    const lang = config.settings.language;
    const name = await vscode.window.showInputBox({
      title: t(lang, 'addGroup'),
      prompt: t(lang, 'groupNamePrompt'),
      value: t(lang, 'newGroup'),
      ignoreFocusOut: true
    });
    if (name?.trim()) {
      config.groups.push({ id: makeId(), name: name.trim(), servers: [] });
      await this.configStore.save(config);
    }
  }

  private async requestRenameGroup(config: AppConfig, groupId: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    const lang = config.settings.language;
    const name = await vscode.window.showInputBox({
      title: t(lang, 'renameGroup'),
      prompt: t(lang, 'newGroupNamePrompt'),
      value: group.name,
      ignoreFocusOut: true
    });
    if (name?.trim()) {
      group.name = name.trim();
      await this.configStore.save(config);
    }
  }

  private async requestDeleteGroup(config: AppConfig, groupId: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    const lang = config.settings.language;
    const confirm = await vscode.window.showWarningMessage(
      t(lang, 'deleteGroupConfirm', group.name),
      { modal: true },
      t(lang, 'delete')
    );
    if (confirm === t(lang, 'delete')) {
      await this.deleteGroup(config, groupId);
    }
  }

  private async requestDeleteServer(config: AppConfig, groupId: string, serverId: string): Promise<void> {
    const group = this.findGroup(config.groups, groupId);
    const server = this.findServer(group, serverId);
    const lang = config.settings.language;
    const confirm = await vscode.window.showWarningMessage(
      t(lang, 'deleteServerConfirm', server.name || server.host),
      { modal: true },
      t(lang, 'delete')
    );
    if (confirm === t(lang, 'delete')) {
      await this.deleteServer(config, groupId, serverId);
    }
  }

  private async deleteGroup(config: AppConfig, groupId: string): Promise<void> {
    this.findGroup(config.groups, groupId);
    const remaining = config.groups.filter((item) => item.id !== groupId);
    config.groups = remaining.length ? remaining : [{ id: defaultGroupId, name: t(config.settings.language, 'defaultGroup'), servers: [] }];
    await this.configStore.save(config);
  }

  private async openTerminal(config: AppConfig, groupId: string, serverId: string): Promise<void> {
    const server = this.findServer(this.findGroup(config.groups, groupId), serverId);
    const auth = await this.resolveAuth(config.settings.language, server);
    new TerminalPage(this.context, server, auth, config.settings);
  }

  private async resolveAuth(language: Language, server: ServerConfig): Promise<ResolvedAuth> {
    if (server.authType === 'privateKey') {
      if (!server.privateKeyPath) {
        throw new Error(t(language, 'privateKeyRequired'));
      }
      const privateKey = await fs.promises.readFile(expandHomePath(server.privateKeyPath));
      const passphrase = server.encryptedPrivateKeyPassphrase ? this.configStore.decryptPassword(server.encryptedPrivateKeyPassphrase) : '';
      return passphrase ? { privateKey, passphrase } : { privateKey };
    }
    let password = server.encryptedPassword ? this.configStore.decryptPassword(server.encryptedPassword) : '';
    if (!password) {
      password = await vscode.window.showInputBox({
        title: t(language, 'passwordRequired'),
        prompt: `${server.username}@${server.host}`,
        password: true,
        ignoreFocusOut: true
      }) ?? '';
    }
    if (!password) {
      throw new Error(t(language, 'passwordRequired'));
    }
    return { password };
  }

  private async postState(): Promise<void> {
    const config = await this.configStore.load();
    const passwords: Record<string, string> = {};
    const privateKeyPassphrases: Record<string, string> = {};
    for (const group of config.groups) {
      for (const server of group.servers) {
        passwords[server.id] = server.encryptedPassword ? this.configStore.decryptPassword(server.encryptedPassword) : '';
        privateKeyPassphrases[server.id] = server.encryptedPrivateKeyPassphrase ? this.configStore.decryptPassword(server.encryptedPrivateKeyPassphrase) : '';
      }
    }
    this.post({ type: 'state', config, groups: config.groups, passwords, privateKeyPassphrases });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.post({ type: 'error', message });
    void vscode.window.showErrorMessage(`tshell: ${message}`);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    button, input, select { font: inherit; border-radius: 5px; border: 1px solid var(--vscode-input-border, transparent); }
    button { cursor: pointer; padding: 5px 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    input, select { width: 100%; padding: 6px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
    label { display: block; margin: 7px 0 3px; color: var(--vscode-descriptionForeground); }
    .top { display: grid; grid-template-columns: 1fr auto auto; gap: 6px; align-items: center; margin-bottom: 10px; }
    .title { font-weight: 700; }
    .tree { border-top: 1px solid var(--vscode-panel-border); margin-top: 8px; }
    details.group { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 0; }
    summary.group-head { display: grid; grid-template-columns: 18px 1fr auto; gap: 4px; align-items: center; list-style: none; cursor: pointer; }
    summary.group-head::-webkit-details-marker { display: none; }
    .chevron { color: var(--vscode-descriptionForeground); text-align: center; transition: transform .12s ease; }
    details[open] .chevron { transform: rotate(90deg); }
    .group-name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .children { margin-left: 18px; padding-top: 4px; }
    .server { display: grid; grid-template-columns: 18px 1fr auto; gap: 4px; align-items: center; margin-top: 4px; padding: 6px; border-radius: 6px; background: transparent; transition: background .12s ease; }
    .server:hover { background: var(--vscode-list-hoverBackground); }
    .server.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
    .server.selected .server-meta { color: var(--vscode-list-activeSelectionForeground); opacity: .86; }
    .server:focus-within { background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground)); }
    .server-main { min-width: 0; cursor: pointer; }
    .server-icon { position: relative; width: 14px; height: 16px; border: 1.4px solid currentColor; border-radius: 3px; opacity: .9; }
    .server-icon::before { content: ''; position: absolute; left: 2px; right: 2px; top: 5px; border-top: 1px solid currentColor; opacity: .75; }
    .server-icon::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .85; }
    .server-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .server-meta { color: var(--vscode-descriptionForeground); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions-inline { display: inline-flex; gap: 2px; justify-content: flex-end; }
    .mini { width: 24px; height: 24px; display: inline-grid; place-items: center; padding: 0; font-size: 14px; line-height: 1; }
    .mini:hover, .mini:focus { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); outline: none; }
    .mini:active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
    .modal { position: fixed; inset: 0; display: none; place-items: center; background: rgba(0,0,0,.35); padding: 12px; }
    .modal.open { display: grid; }
    .dialog { width: min(360px, 100%); padding: 12px; border-radius: 8px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .dialog-title { font-weight: 700; margin-bottom: 8px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
    .status { margin-top: 8px; color: var(--vscode-errorForeground); min-height: 18px; }
    .context-menu { position: fixed; display: none; z-index: 20; min-width: 160px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
    .context-menu.open { display: block; }
    .context-item { padding: 6px 10px; border-radius: 3px; cursor: pointer; user-select: none; white-space: nowrap; }
    .context-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
  </style>
</head>
<body>
  <div class="top">
    <div id="title" class="title">远程服务器</div>
    <button id="addGroup" class="mini">添加分组</button>
    <button id="openConfig" class="mini secondary">⚙</button>
  </div>
  <div id="groups" class="tree"></div>
  <div id="status" class="status"></div>

  <div id="serverModal" class="modal">
    <div class="dialog">
      <div id="serverDialogTitle" class="dialog-title">服务器</div>
      <input id="serverId" type="hidden">
      <input id="serverGroupId" type="hidden">
      <label id="serverNameLabel" for="serverName">名称</label>
      <input id="serverName" placeholder="生产服务器">
      <label id="hostLabel" for="host">主机</label>
      <input id="host" placeholder="192.168.1.10">
      <label id="portLabel" for="port">端口</label>
      <input id="port" type="number" value="22">
      <label id="usernameLabel" for="username">用户</label>
      <input id="username" placeholder="root / ubuntu">
      <label id="authTypeLabel" for="authType">认证方式</label>
      <select id="authType">
        <option value="password">Password</option>
        <option value="privateKey">Private Key</option>
      </select>
      <label id="passwordLabel" for="password">密码</label>
      <input id="password" type="password">
      <label id="privateKeyPathLabel" for="privateKeyPath">私钥路径</label>
      <input id="privateKeyPath" placeholder="C:\\Users\\you\\.ssh\\id_rsa">
      <label id="privateKeyPassphraseLabel" for="privateKeyPassphrase">私钥 Passphrase</label>
      <input id="privateKeyPassphrase" type="password">
      <label id="encodingLabel" for="encoding">输入输出编码</label>
      <select id="encoding">
        <option value="utf-8">UTF-8</option>
        <option value="gb18030">GB2312 / GBK</option>
      </select>
      <div class="actions">
        <button id="saveServer">保存</button>
        <button id="cancelServer" class="secondary">取消</button>
      </div>
    </div>
  </div>
  <div id="contextMenu" class="context-menu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let state = { groups: [], passwords: {}, privateKeyPassphrases: {}, config: { settings: { language: 'en-US', showHiddenFiles: false } } };
    let selectedServerId = '';
    const icons = { addGroup: '+', openConfig: '⚙', addServer: '⊕', renameGroup: '✎', deleteGroup: '🗑', edit: '✎', delete: '🗑' };
    const i18n = {
      'zh-CN': {
        title: '远程服务器',
        addGroup: '添加分组',
        openConfig: '打开配置文件',
        addServer: '添加服务器',
        renameGroup: '修改分组名',
        deleteGroup: '删除分组',
        edit: '编辑',
        delete: '删除',
        empty: '暂无服务器',
        editServer: '修改服务器',
        newServer: '添加服务器',
        name: '名称',
        host: '主机',
        port: '端口',
        username: '用户',
        password: '密码',
        authType: '认证方式',
        passwordAuth: '密码',
        privateKeyAuth: '私钥',
        privateKeyPath: '私钥路径',
        privateKeyPassphrase: '私钥 Passphrase',
        editServerAction: '修改服务器',
        deleteServerAction: '删除服务器',
        encoding: '输入输出编码',
        save: '保存',
        cancel: '取消',
        required: '主机和用户不能为空。',
        privateKeyRequired: '请填写私钥路径。',
        defaultGroup: '默认分组',
        serverPlaceholder: '生产服务器',
        doubleClickConnect: '双击连接'
      },
      'en-US': {
        title: 'Remote Servers',
        addGroup: 'Add Group',
        openConfig: 'Open Config File',
        addServer: 'Add Server',
        renameGroup: 'Rename Group',
        deleteGroup: 'Delete Group',
        edit: 'Edit',
        delete: 'Delete',
        empty: 'No servers',
        editServer: 'Edit Server',
        newServer: 'Add Server',
        name: 'Name',
        host: 'Host',
        port: 'Port',
        username: 'User',
        password: 'Password',
        authType: 'Authentication',
        passwordAuth: 'Password',
        privateKeyAuth: 'Private Key',
        privateKeyPath: 'Private Key Path',
        privateKeyPassphrase: 'Private Key Passphrase',
        editServerAction: 'Edit Server',
        deleteServerAction: 'Delete Server',
        encoding: 'Input/Output Encoding',
        save: 'Save',
        cancel: 'Cancel',
        required: 'Host and user are required.',
        privateKeyRequired: 'Private key path is required.',
        defaultGroup: 'Default Group',
        serverPlaceholder: 'Production Server',
        doubleClickConnect: 'Double-click to connect'
      }
    };

    function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }
    function status(text) { $('status').textContent = text || ''; }
    function lang() { return state.config?.settings?.language || 'en-US'; }
    function text(key) { return (i18n[lang()] || i18n['zh-CN'])[key] || key; }
    function hideContextMenu() {
      $('contextMenu').classList.remove('open');
    }
    function showContextMenu(event, items) {
      const menu = $('contextMenu');
      menu.innerHTML = '';
      for (const [label, action] of items) {
        const item = document.createElement('div');
        item.className = 'context-item';
        item.textContent = label;
        item.onclick = () => {
          hideContextMenu();
          action();
        };
        menu.append(item);
      }
      menu.style.left = Math.min(event.clientX, window.innerWidth - 180) + 'px';
      menu.style.top = Math.min(event.clientY, window.innerHeight - 160) + 'px';
      menu.classList.add('open');
    }
    function translateUi() {
      $('title').textContent = text('title');
      $('addGroup').textContent = icons.addGroup;
      $('addGroup').title = text('addGroup');
      $('addGroup').setAttribute('aria-label', text('addGroup'));
      $('openConfig').textContent = icons.openConfig;
      $('openConfig').title = text('openConfig');
      $('openConfig').setAttribute('aria-label', text('openConfig'));
      $('serverName').placeholder = text('serverPlaceholder');
      $('serverNameLabel').textContent = text('name');
      $('hostLabel').textContent = text('host');
      $('portLabel').textContent = text('port');
      $('usernameLabel').textContent = text('username');
      $('authTypeLabel').textContent = text('authType');
      $('authType').options[0].textContent = text('passwordAuth');
      $('authType').options[1].textContent = text('privateKeyAuth');
      $('passwordLabel').textContent = text('password');
      $('privateKeyPathLabel').textContent = text('privateKeyPath');
      $('privateKeyPassphraseLabel').textContent = text('privateKeyPassphrase');
      $('encodingLabel').textContent = text('encoding');
      $('saveServer').textContent = text('save');
      $('cancelServer').textContent = text('cancel');
    }

    function render() {
      const root = $('groups');
      root.innerHTML = '';
      for (const group of state.groups) {
        const wrap = document.createElement('details');
        wrap.className = 'group';
        wrap.open = true;
        const head = document.createElement('summary');
        head.className = 'group-head';
        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '›';
        const name = document.createElement('div');
        name.className = 'group-name';
        name.textContent = group.id === 'default' ? text('defaultGroup') : group.name;
        const add = mini(icons.addServer, text('addServer'), () => openServerDialog(group.id));
        const rename = mini(icons.renameGroup, text('renameGroup'), () => renameGroup(group));
        const del = mini(icons.deleteGroup, text('deleteGroup'), () => deleteGroup(group));
        for (const button of [add, rename, del]) {
          button.onclick = ((handler) => (event) => {
            event.preventDefault();
            event.stopPropagation();
            handler();
          })(button.onclick);
        }
        const groupActions = document.createElement('div');
        groupActions.className = 'actions-inline';
        groupActions.append(add, rename, del);
        head.oncontextmenu = (event) => {
          event.preventDefault();
          event.stopPropagation();
          showContextMenu(event, [
            [text('addGroup'), () => post('requestAddGroup')],
            [text('renameGroup'), () => renameGroup(group)],
            [text('deleteGroup'), () => deleteGroup(group)],
            [text('addServer'), () => openServerDialog(group.id)]
          ]);
        };
        head.append(chevron, name, groupActions);
        wrap.append(head);
        const children = document.createElement('div');
        children.className = 'children';
        if (!group.servers.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = text('empty');
          children.append(empty);
        }
        for (const server of group.servers) {
          const row = document.createElement('div');
          row.className = 'server';
          row.tabIndex = 0;
          if (selectedServerId === server.id) row.classList.add('selected');
          const icon = document.createElement('span');
          icon.className = 'server-icon';
          icon.title = server.name || server.host;
          const main = document.createElement('div');
          main.className = 'server-main';
          main.title = text('doubleClickConnect');
          main.onclick = () => {
            selectedServerId = server.id;
            render();
          };
          main.ondblclick = () => post('openTerminal', { groupId: group.id, serverId: server.id });
          const title = document.createElement('div');
          title.className = 'server-name';
          title.textContent = server.name === '生产服务器' ? text('serverPlaceholder') : (server.name || server.host);
          const meta = document.createElement('div');
          meta.className = 'server-meta';
          meta.textContent = server.username + '@' + server.host + ':' + server.port;
          main.append(title, meta);
          row.oncontextmenu = (event) => {
            event.preventDefault();
            event.stopPropagation();
            selectedServerId = server.id;
            render();
            showContextMenu(event, [
              [text('edit'), () => openServerDialog(group.id, server)],
              [text('delete'), () => deleteServer(group, server)]
            ]);
          };
          const serverActions = document.createElement('div');
          serverActions.className = 'actions-inline';
          serverActions.append(mini(icons.edit, text('editServerAction'), () => openServerDialog(group.id, server)), mini(icons.delete, text('deleteServerAction'), () => deleteServer(group, server)));
          row.append(icon, main, serverActions);
          children.append(row);
        }
        wrap.append(children);
        root.append(wrap);
      }
    }

    function mini(icon, label, onClick) {
      const button = document.createElement('button');
      button.className = 'mini secondary';
      button.textContent = icon;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.onclick = onClick;
      return button;
    }

    function openServerDialog(groupId, server) {
      $('serverDialogTitle').textContent = server ? text('editServer') : text('newServer');
      $('serverGroupId').value = groupId;
      $('serverId').value = server?.id || '';
      $('serverName').value = server?.name || '';
      $('host').value = server?.host || '';
      $('port').value = server?.port || 22;
      $('username').value = server?.username || '';
      $('authType').value = server?.authType || (server?.privateKeyPath ? 'privateKey' : 'password');
      $('password').value = server ? (state.passwords[server.id] || '') : '';
      $('privateKeyPath').value = server?.privateKeyPath || '';
      $('privateKeyPassphrase').value = server ? (state.privateKeyPassphrases[server.id] || '') : '';
      $('encoding').value = server?.encoding || 'utf-8';
      updateAuthFields();
      $('serverModal').classList.add('open');
    }

    function updateAuthFields() {
      const privateKey = $('authType').value === 'privateKey';
      $('passwordLabel').style.display = privateKey ? 'none' : '';
      $('password').style.display = privateKey ? 'none' : '';
      $('privateKeyPathLabel').style.display = privateKey ? '' : 'none';
      $('privateKeyPath').style.display = privateKey ? '' : 'none';
      $('privateKeyPassphraseLabel').style.display = privateKey ? '' : 'none';
      $('privateKeyPassphrase').style.display = privateKey ? '' : 'none';
    }

    function closeServerDialog() { $('serverModal').classList.remove('open'); }

    function renameGroup(group) {
      post('requestRenameGroup', { groupId: group.id });
    }

    function deleteGroup(group) {
      post('requestDeleteGroup', { groupId: group.id });
    }

    function deleteServer(group, server) {
      post('requestDeleteServer', { groupId: group.id, serverId: server.id });
    }

    $('addGroup').onclick = () => {
      post('requestAddGroup');
    };
    $('openConfig').onclick = () => {
      post('openConfig');
    };
    document.body.addEventListener('click', hideContextMenu);
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideContextMenu();
    });
    document.body.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.group-head') || event.target.closest('.server') || event.target.closest('.modal')) return;
      event.preventDefault();
      showContextMenu(event, [[text('addGroup'), () => post('requestAddGroup')]]);
    });
    $('cancelServer').onclick = closeServerDialog;
    $('serverModal').onclick = (event) => { if (event.target === $('serverModal')) closeServerDialog(); };
    $('saveServer').onclick = () => {
      const server = {
        id: $('serverId').value,
        name: $('serverName').value.trim(),
        host: $('host').value.trim(),
        port: Number($('port').value) || 22,
        username: $('username').value.trim(),
        authType: $('authType').value,
        privateKeyPath: $('privateKeyPath').value.trim(),
        encoding: $('encoding').value
      };
      if (!server.host || !server.username) { status(text('required')); return; }
      if (server.authType === 'privateKey' && !server.privateKeyPath) { status(text('privateKeyRequired')); return; }
      const type = server.id ? 'updateServer' : 'addServer';
      post(type, { groupId: $('serverGroupId').value, server, password: $('password').value, privateKeyPassphrase: $('privateKeyPassphrase').value });
      closeServerDialog();
    };
    $('authType').onchange = updateAuthFields;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        state = { config: message.config || {}, groups: message.groups || [], passwords: message.passwords || {}, privateKeyPassphrases: message.privateKeyPassphrases || {} };
        status('');
        translateUi();
        render();
      }
      if (message.type === 'error') status(message.message);
    });
    translateUi();
  </script>
</body>
</html>`;
  }
}

class TerminalPage {
  private static active?: TerminalPage;
  private static readonly titleCounts = new Map<string, number>();
  private readonly panel: vscode.WebviewPanel;
  private client?: Client;
  private shell?: ClientChannel;
  private decoder: NodeJS.ReadWriteStream;
  private connected = false;
  private connecting = false;
  private terminalCols = 120;
  private terminalRows = 36;
  private terminalTranscript = '';
  private statusText = '';
  private readonly baseTitle: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerConfig,
    private readonly auth: ResolvedAuth,
    private readonly settings: AppSettings,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.One,
    title?: string
  ) {
    this.baseTitle = server.name || server.host;
    this.decoder = iconv.decodeStream(server.encoding);
    this.panel = vscode.window.createWebviewPanel(
      'tshell.terminal',
      title ?? this.baseTitle,
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@xterm', 'xterm'),
          vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@xterm', 'addon-fit')
        ]
      }
    );
    this.panel.webview.html = this.renderHtml();
    TerminalPage.active = this;
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPage.active = this;
      }
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  static copyActiveSession(): void {
    if (!TerminalPage.active) {
      void vscode.window.showInformationMessage(t(vsCodeLanguage(), 'noActiveSession'));
      return;
    }
    TerminalPage.active.copySession();
  }

  static async renameActiveSession(): Promise<void> {
    if (!TerminalPage.active) {
      void vscode.window.showInformationMessage(t(vsCodeLanguage(), 'noActiveSession'));
      return;
    }
    await TerminalPage.active.renameSession();
  }

  static openActiveTransfer(): void {
    if (!TerminalPage.active) {
      void vscode.window.showInformationMessage(t(vsCodeLanguage(), 'noActiveSession'));
      return;
    }
    TerminalPage.active.openTransfer();
  }

  private copySession(): void {
    new TerminalPage(this.context, this.server, this.auth, this.settings, this.panel.viewColumn ?? vscode.ViewColumn.One, TerminalPage.nextTitle(this.baseTitle));
  }

  private openTransfer(): void {
    new TransferPage(this.context, this.server, this.auth, this.settings, vscode.ViewColumn.Beside);
  }

  private static nextTitle(baseTitle: string): string {
    const next = (TerminalPage.titleCounts.get(baseTitle) ?? 0) + 1;
    TerminalPage.titleCounts.set(baseTitle, next);
    return `${baseTitle}(${next})`;
  }

  private async renameSession(): Promise<void> {
    const next = await vscode.window.showInputBox({
      title: t(this.settings.language, 'renameSession'),
      value: this.panel.title,
      prompt: t(this.settings.language, 'sessionNamePrompt')
    });
    if (next?.trim()) {
      this.panel.title = next.trim();
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.handleReady();
          break;
        case 'input':
          await this.handleInput(String(message.data ?? ''));
          break;
        case 'resize':
          this.terminalRows = Number(message.rows) || this.terminalRows;
          this.terminalCols = Number(message.cols) || this.terminalCols;
          this.shell?.setWindow(this.terminalRows, this.terminalCols, 0, 0);
          break;
        case 'openTransfer':
          this.openTransfer();
          break;
        case 'copySession':
          this.copySession();
          break;
        case 'renameSession':
          await this.renameSession();
          break;
        case 'copyText':
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          break;
        case 'readClipboard':
          this.post({ type: 'clipboardText', text: await vscode.env.clipboard.readText() });
          break;
      }
    } catch (error) {
      this.report(error);
    }
  }

  private async handleReady(): Promise<void> {
    if (this.terminalTranscript) {
      this.post({ type: 'snapshot', output: this.terminalTranscript });
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.connected && this.shell) return;
    this.connecting = true;
    this.disposeConnection();
    this.updateStatus(`${t(this.settings.language, 'connecting')} ${this.server.username}@${this.server.host}:${this.server.port} ...`);
    try {
      this.client = new Client();
      await new Promise<void>((resolve, reject) => {
        this.client!
          .once('ready', resolve)
          .once('error', reject)
          .connect(this.connectConfig());
      });

      this.shell = await new Promise<ClientChannel>((resolve, reject) => {
        this.client!.shell({ term: 'xterm-256color', cols: this.terminalCols, rows: this.terminalRows }, (error, channel) => {
          if (error) reject(error);
          else resolve(channel);
        });
      });

      this.decoder = iconv.decodeStream(this.server.encoding);
      this.decoder.on('data', (chunk: string) => {
        this.appendTranscript(chunk);
        this.post({ type: 'output', data: chunk });
      });
      this.shell.pipe(this.decoder);
      this.shell.stderr.pipe(this.decoder);
      this.shell.on('close', () => this.markClosed(t(this.settings.language, 'connectionClosedRetryEnter')));
      this.client.once('close', () => this.markClosed(t(this.settings.language, 'sshClosedRetryEnter')));
      this.connected = true;
      this.updateStatus(`${t(this.settings.language, 'connected')}: ${this.server.username}@${this.server.host}`, 'connected', true);
      this.shell.setWindow(this.terminalRows, this.terminalCols, 0, 0);
    } finally {
      this.connecting = false;
    }
  }

  private async handleInput(data: string): Promise<void> {
    if (this.connected && this.shell) {
      this.shell.write(this.encodeInput(data));
      return;
    }
    if (data.includes('\r') || data.includes('\n')) {
      await this.connect();
    }
  }

  private encodeInput(input: string): Buffer {
    return this.server.encoding === 'gb18030' ? iconv.encode(input, 'gb18030') : Buffer.from(input, 'utf8');
  }

  private connectConfig(): ConnectConfig {
    return {
      host: this.server.host,
      port: this.server.port,
      username: this.server.username,
      ...this.auth,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3
    };
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateStatus(`${t(this.settings.language, 'connectFailed')}: ${message}`);
  }

  private appendTranscript(data: string): void {
    const maxTranscriptLength = 300000;
    this.terminalTranscript += data;
    if (this.terminalTranscript.length > maxTranscriptLength) {
      this.terminalTranscript = this.terminalTranscript.slice(this.terminalTranscript.length - maxTranscriptLength);
    }
  }

  private updateStatus(text: string, type: 'status' | 'connected' = 'status', clear = false): void {
    this.statusText = text;
    const line = `\r\n${text}\r\n`;
    if (clear) {
      this.terminalTranscript = '';
      this.post({ type, text, clear: true, output: '' });
      return;
    }
    this.appendTranscript(line);
    this.post({ type: 'output', data: line });
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    if (TerminalPage.active === this) {
      TerminalPage.active = undefined;
    }
    this.disposeConnection();
  }

  private disposeConnection(): void {
    this.connected = false;
    this.shell?.end();
    this.client?.end();
    this.shell = undefined;
    this.client = undefined;
  }

  private markClosed(text: string): void {
    if (this.connecting) return;
    if (!this.connected) return;
    this.connected = false;
    this.shell = undefined;
    this.client = undefined;
    this.updateStatus(text);
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const xtermJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
    const xtermCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
    const fitJs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));
    const fileTransferText = t(this.settings.language, 'fileTransfer');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${xtermCss}">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { position: relative; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    #terminal { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 0; padding: 0; background: var(--vscode-editor-background); overflow: hidden; }
    .transfer-float { position: absolute; top: 6px; right: 8px; z-index: 5; width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 5px; color: #22c55e; background: transparent; cursor: pointer; }
    .transfer-float:hover { background: color-mix(in srgb, #22c55e 18%, transparent); }
    .transfer-float svg { width: 23px; height: 23px; display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.38)); }
    .xterm { height: 100%; padding: 0; }
    .xterm .xterm-viewport, .xterm .xterm-screen { background: var(--vscode-editor-background) !important; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <button id="transfer" class="transfer-float" title="${fileTransferText}" aria-label="${fileTransferText}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z"></path>
      <path d="M3.5 8.5v-2.5a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v.5"></path>
    </svg>
  </button>
  <script nonce="${nonce}" src="${xtermJs}"></script>
  <script nonce="${nonce}" src="${fitJs}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const terminalElement = document.getElementById('terminal');
    function terminalTheme() {
      const styles = getComputedStyle(document.body);
      const light = document.body.classList.contains('vscode-light');
      return {
        background: styles.backgroundColor,
        foreground: styles.color,
        cursor: styles.color,
        selectionBackground: light ? '#add6ff' : '#264f78',
        black: light ? '#000000' : '#000000',
        red: light ? '#a31515' : '#cd3131',
        green: light ? '#008000' : '#0dbc79',
        yellow: light ? '#795e26' : '#e5e510',
        blue: light ? '#0451a5' : '#2472c8',
        magenta: light ? '#af00db' : '#bc3fbc',
        cyan: light ? '#008080' : '#11a8cd',
        white: light ? '#555555' : '#e5e5e5',
        brightBlack: light ? '#666666' : '#666666',
        brightRed: light ? '#cd3131' : '#f14c4c',
        brightGreen: light ? '#14ce14' : '#23d18b',
        brightYellow: light ? '#b5a642' : '#f5f543',
        brightBlue: light ? '#0000ff' : '#3b8eea',
        brightMagenta: light ? '#af00db' : '#d670d6',
        brightCyan: light ? '#008080' : '#29b8db',
        brightWhite: light ? '#000000' : '#ffffff'
      };
    }
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      theme: terminalTheme()
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalElement);
    term.focus();
    const transferButton = document.getElementById('transfer');
    terminalElement.addEventListener('mousedown', () => term.focus());
    document.body.addEventListener('mousedown', (event) => {
      if (!transferButton.contains(event.target)) term.focus();
    });
    transferButton.addEventListener('click', () => vscode.postMessage({ type: 'openTransfer' }));
    transferButton.addEventListener('contextmenu', (event) => event.preventDefault());
    term.onData((data) => vscode.postMessage({ type: 'input', data }));
    term.onSelectionChange(() => {
      if (term.hasSelection()) {
        vscode.postMessage({ type: 'copyText', text: term.getSelection() });
      }
    });
    document.body.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
    terminalElement.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      term.focus();
      vscode.postMessage({ type: 'readClipboard' });
    });
    function resize() {
      fitAddon.fit();
      vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
    }
    function scheduleResize() {
      requestAnimationFrame(() => {
        resize();
        setTimeout(resize, 50);
      });
    }
    window.addEventListener('resize', resize);
    new ResizeObserver(scheduleResize).observe(terminalElement);
    new MutationObserver(() => term.options.theme = terminalTheme()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'snapshot') {
        term.reset();
        term.write(message.output || '');
      }
      if (message.type === 'output') term.write(message.data || '');
      if (message.type === 'clipboardText' && message.text) vscode.postMessage({ type: 'input', data: message.text });
      if (message.type === 'connected') {
        if (message.clear) {
          term.reset();
          term.write(message.output || '');
        }
        scheduleResize();
        term.focus();
      }
    });
    scheduleResize();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

class TransferPage {
  private static readonly titleCounts = new Map<string, number>();
  private readonly panel: vscode.WebviewPanel;
  private client?: Client;
  private sftp?: SFTPWrapper;
  private currentPath = '.';
  private connected = false;
  private connecting = false;
  private readonly logLines: string[] = [];
  private readonly baseTitle: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerConfig,
    private readonly auth: ResolvedAuth,
    private readonly settings: AppSettings,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside
  ) {
    this.baseTitle = `${t(settings.language, 'fileTransfer')} - ${server.name || server.host}`;
    this.panel = vscode.window.createWebviewPanel(
      'tshell.transfer',
      TransferPage.nextTitle(this.baseTitle),
      viewColumn,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    this.panel.onDidDispose(() => this.dispose());
  }

  private static nextTitle(baseTitle: string): string {
    const current = TransferPage.titleCounts.get(baseTitle) ?? 0;
    TransferPage.titleCounts.set(baseTitle, current + 1);
    return current === 0 ? baseTitle : `${baseTitle}(${current})`;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.post({ type: 'logSnapshot', lines: this.logLines });
          await this.list(this.currentPath);
          break;
        case 'list':
          await this.list(String(message.path ?? this.currentPath));
          break;
        case 'refresh':
          await this.list(this.currentPath);
          break;
        case 'upload':
          await this.openUploadPicker(String(message.path ?? os.homedir()));
          break;
        case 'listLocal':
          await this.openUploadPicker(String(message.path ?? os.homedir()));
          break;
        case 'uploadLocal':
          await this.uploadLocal(toLocalPaths(message.paths));
          break;
        case 'download':
          await this.download([{ path: String(message.path), isDirectory: Boolean(message.isDirectory) }]);
          break;
        case 'downloadMany':
          await this.download(toDownloadItems(message.items));
          break;
        case 'openTextFile':
          await this.openTextFile(String(message.path ?? ''), normalizePreviewEncoding(String(message.encoding ?? ''), this.server.encoding));
          break;
        case 'loadTextChunk':
          await this.loadTextChunk(String(message.path ?? ''), normalizePreviewEncoding(String(message.encoding ?? ''), this.server.encoding), Number(message.offset) || 0);
          break;
        case 'loadDbfChunk':
          await this.loadDbfChunk(String(message.path ?? ''), normalizePreviewEncoding(String(message.encoding ?? ''), this.server.encoding), Number(message.recordOffset) || 0);
          break;
        case 'copyText':
          await vscode.env.clipboard.writeText(String(message.text ?? ''));
          break;
      }
    } catch (error) {
      this.report(error);
    }
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.connected && this.sftp) return;
    this.connecting = true;
    this.disposeConnection();
    this.log(t(this.settings.language, 'connectingTransfer'));
    try {
      this.client = new Client();
      await new Promise<void>((resolve, reject) => {
        this.client!.once('ready', resolve).once('error', reject).connect({
          host: this.server.host,
          port: this.server.port,
          username: this.server.username,
          ...this.auth,
          readyTimeout: 20000,
          keepaliveInterval: 15000
        });
      });
      this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        this.client!.sftp((error, sftp) => error ? reject(error) : resolve(sftp));
      });
      this.client.once('close', () => this.markClosed(t(this.settings.language, 'transferClosedRetry')));
      this.sftp.once('close', () => this.markClosed(t(this.settings.language, 'transferClosedRetry')));
      this.connected = true;
      this.log(t(this.settings.language, 'transferConnected'));
    } finally {
      this.connecting = false;
    }
  }

  private async list(remotePath: string): Promise<void> {
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    this.currentPath = remotePath.trim() || '.';
    const entries = await this.readdir(this.currentPath);
    this.post({ type: 'list', path: this.currentPath, entries });
  }

  private readdir(remotePath: string): Promise<RemoteEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp!.readdir(remotePath, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        const entries: RemoteEntry[] = list
          .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
          .filter((entry) => this.settings.showHiddenFiles || !entry.filename.startsWith('.'))
          .map((entry) => {
            const type: RemoteEntryType = entry.longname.startsWith('d')
              ? 'directory'
              : entry.longname.startsWith('l')
                ? 'symlink'
                : entry.longname.startsWith('-')
                  ? 'file'
                  : 'other';
            return {
              name: entry.filename,
              path: joinRemote(remotePath, entry.filename),
              type,
              size: entry.attrs.size,
              modifiedAt: entry.attrs.mtime * 1000
            };
          })
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
          });
        resolve(entries);
      });
    });
  }

  private async openUploadPicker(localPath: string): Promise<void> {
    const trimmed = localPath.trim();
    const target = trimmed === '' ? '' : normalizeLocalPath(trimmed);
    const entries = await this.readdirLocal(target);
    this.post({ type: 'localList', path: target, entries });
  }

  private async uploadLocal(localPaths: string[]): Promise<void> {
    if (!localPaths.length) {
      this.log(t(this.settings.language, 'selectUploadItems'));
      return;
    }
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    for (const localPath of localPaths) {
      const stat = await fs.promises.stat(localPath);
      const remotePath = joinRemote(this.currentPath, path.basename(localPath));
      this.log(`${t(this.settings.language, 'startUpload')}: ${localPath} -> ${remotePath}`);
      if (stat.isDirectory()) {
        await this.uploadDirectory(localPath, remotePath);
      } else if (stat.isFile()) {
        this.log(`${t(this.settings.language, 'uploadingFile')}: ${localPath} -> ${remotePath}`);
        await this.fastPut(localPath, remotePath);
        this.log(`${t(this.settings.language, 'fileUploadDone')}: ${remotePath}`);
      }
      this.log(`${t(this.settings.language, 'uploadDone')}: ${remotePath}`);
    }
    await this.list(this.currentPath);
    this.log(t(this.settings.language, 'uploadDone'));
  }

  private async readdirLocal(localPath: string): Promise<LocalEntry[]> {
    if (localPath === '') {
      return listWindowsDrives();
    }
    const entries = await fs.promises.readdir(localPath, { withFileTypes: true });
    const result = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(localPath, entry.name);
      try {
        const stat = await fs.promises.stat(entryPath);
        const type: LocalEntry['type'] = entry.isDirectory() ? 'directory' : 'file';
        return { name: entry.name, path: entryPath, type, size: stat.size, modifiedAt: stat.mtimeMs };
      } catch {
        if (entry.isDirectory()) {
          return { name: entry.name, path: entryPath, type: 'directory' as const, size: 0, modifiedAt: 0 };
        }
        return undefined;
      }
    }));
    return result
      .filter((entry): entry is LocalEntry => Boolean(entry))
      .filter((entry) => this.settings.showHiddenFiles || !entry.name.startsWith('.'))
      .filter((entry) => entry.type === 'directory' || entry.type === 'file')
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });
  }

  private async download(items: DownloadRequestItem[]): Promise<void> {
    if (!items.length) {
      this.log(t(this.settings.language, 'selectDownloadItems'));
      return;
    }
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: t(this.settings.language, 'selectDownloadFolder') });
    if (!uris?.length) return;
    for (const item of items) {
      const localTarget = path.join(uris[0].fsPath, basenameRemote(item.path));
      this.log(`${t(this.settings.language, 'downloading')}: ${item.path} -> ${localTarget}`);
      if (item.isDirectory) {
        await this.downloadDirectory(item.path, localTarget);
      } else {
        await fs.promises.mkdir(path.dirname(localTarget), { recursive: true });
        await this.fastGet(item.path, localTarget);
      }
      this.log(`${t(this.settings.language, 'downloadDone')}: ${localTarget}`);
    }
    this.log(`${t(this.settings.language, 'downloadDone')}: ${items.length}`);
  }

  private async uploadDirectory(localDirectory: string, remoteDirectory: string): Promise<void> {
    await this.mkdir(remoteDirectory);
    const entries = await fs.promises.readdir(localDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const localPath = path.join(localDirectory, entry.name);
      const remotePath = joinRemote(remoteDirectory, entry.name);
      if (entry.isDirectory()) await this.uploadDirectory(localPath, remotePath);
      else if (entry.isFile()) {
        this.log(`${t(this.settings.language, 'uploadingFile')}: ${localPath} -> ${remotePath}`);
        await this.fastPut(localPath, remotePath);
        this.log(`${t(this.settings.language, 'fileUploadDone')}: ${remotePath}`);
      }
    }
  }

  private async downloadDirectory(remoteDirectory: string, localDirectory: string): Promise<void> {
    await fs.promises.mkdir(localDirectory, { recursive: true });
    const entries = await this.readdir(remoteDirectory);
    for (const entry of entries) {
      const localPath = path.join(localDirectory, entry.name);
      if (entry.type === 'directory') await this.downloadDirectory(entry.path, localPath);
      else if (entry.type === 'file' || entry.type === 'symlink') {
        this.log(`${t(this.settings.language, 'downloadingFile')}: ${entry.path} -> ${localPath}`);
        await this.fastGet(entry.path, localPath);
        this.log(`${t(this.settings.language, 'fileDownloadDone')}: ${localPath}`);
      }
    }
  }

  private mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp!.mkdir(remotePath, (error) => {
        if (!error) {
          resolve();
          return;
        }
        this.sftp!.stat(remotePath, (statError, attrs) => {
          if (!statError && attrs.isDirectory()) resolve();
          else reject(error);
        });
      });
    });
  }

  private fastPut(localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => this.sftp!.fastPut(localPath, remotePath, (error) => error ? reject(error) : resolve()));
  }

  private fastGet(remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => this.sftp!.fastGet(remotePath, localPath, (error) => error ? reject(error) : resolve()));
  }

  private async openTextFile(remotePath: string, encoding: PreviewEncoding): Promise<void> {
    if (!remotePath) {
      return;
    }
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    if (isDbfFile(remotePath)) {
      await this.openDbfFile(remotePath, encoding);
      return;
    }
    const preview = await this.readRemoteTextChunk(remotePath, encoding, 0);
    this.post({
      type: 'textPreview',
      path: remotePath,
      name: basenameRemote(remotePath),
      language: previewLanguage(remotePath),
      encoding,
      content: preview.content,
      unsupported: preview.binary,
      message: preview.binary ? t(this.settings.language, 'unsupportedBinaryPreview') : '',
      done: preview.done,
      nextOffset: preview.nextOffset,
      totalSize: preview.size
    });
    if (preview.binary) {
      this.log(`${t(this.settings.language, 'unsupportedBinaryPreview')}: ${remotePath}`);
    } else {
      this.log(`${t(this.settings.language, 'previewing')}: ${remotePath}`);
    }
  }

  private async openDbfFile(remotePath: string, encoding: PreviewEncoding): Promise<void> {
    const preview = await this.readDbfPreview(remotePath, encoding, 0);
    this.post({
      type: 'dbfPreview',
      path: remotePath,
      name: basenameRemote(remotePath),
      language: 'dbf',
      encoding,
      fields: preview.fields,
      rows: preview.rows,
      recordCount: preview.recordCount,
      nextRecord: preview.nextRecord,
      done: preview.done
    });
    this.log(`${t(this.settings.language, 'previewing')}: ${remotePath}`);
  }

  private async loadTextChunk(remotePath: string, encoding: PreviewEncoding, offset: number): Promise<void> {
    if (!remotePath) return;
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    const preview = await this.readRemoteTextChunk(remotePath, encoding, offset);
    this.post({
      type: 'textChunk',
      path: remotePath,
      encoding,
      content: preview.content,
      done: preview.done,
      nextOffset: preview.nextOffset,
      totalSize: preview.size
    });
  }

  private async loadDbfChunk(remotePath: string, encoding: PreviewEncoding, recordOffset: number): Promise<void> {
    if (!remotePath) return;
    if (!this.sftp || !this.connected) {
      await this.connect();
    }
    this.ensureSftp();
    const preview = await this.readDbfPreview(remotePath, encoding, recordOffset);
    this.post({
      type: 'dbfChunk',
      path: remotePath,
      encoding,
      rows: preview.rows,
      nextRecord: preview.nextRecord,
      done: preview.done
    });
  }

  private async readRemoteTextChunk(remotePath: string, encoding: PreviewEncoding, offset: number): Promise<TextPreviewResult> {
    const chunkBytes = 512 * 1024;
    const attrs = await this.stat(remotePath);
    const size = attrs.size || 0;
    if (offset >= size && size > 0) {
      return { content: '', binary: false, done: true, nextOffset: size, size };
    }
    const bytesToRead = Math.min(chunkBytes, Math.max(0, size - offset || chunkBytes));
    const buffer = await this.readRemoteBytes(remotePath, offset, bytesToRead);
    if (offset === 0 && isLikelyBinary(buffer)) {
      return { content: '', binary: true, done: true, nextOffset: buffer.length, size };
    }
    const text = encoding === 'gb2312' ? iconv.decode(buffer, 'gb18030') : buffer.toString('utf8');
    const nextOffset = offset + buffer.length;
    return { content: text, binary: false, done: nextOffset >= size, nextOffset, size };
  }

  private async readDbfPreview(remotePath: string, encoding: PreviewEncoding, recordOffset: number): Promise<DbfPreviewResult> {
    const headerStart = await this.readRemoteBytes(remotePath, 0, 4096);
    if (headerStart.length < 32) {
      throw new Error(t(this.settings.language, 'invalidDbfFile'));
    }
    const recordCount = headerStart.readUInt32LE(4);
    const headerLength = headerStart.readUInt16LE(8);
    const recordLength = headerStart.readUInt16LE(10);
    if (headerLength < 33 || recordLength < 1) {
      throw new Error(t(this.settings.language, 'invalidDbfFile'));
    }
    const header = headerStart.length >= headerLength ? headerStart.subarray(0, headerLength) : await this.readRemoteBytes(remotePath, 0, headerLength);
    const fields = this.parseDbfFields(header, encoding);
    const rowsPerChunk = 300;
    const safeRecordOffset = Math.max(0, Math.min(recordOffset, recordCount));
    const recordsToRead = Math.min(rowsPerChunk, recordCount - safeRecordOffset);
    if (recordsToRead <= 0) {
      return { fields, rows: [], recordCount, nextRecord: recordCount, done: true };
    }
    const dataOffset = headerLength + safeRecordOffset * recordLength;
    const data = await this.readRemoteBytes(remotePath, dataOffset, recordsToRead * recordLength);
    const rows = this.parseDbfRows(data, fields, recordLength, encoding);
    const nextRecord = safeRecordOffset + recordsToRead;
    return { fields, rows, recordCount, nextRecord, done: nextRecord >= recordCount };
  }

  private parseDbfFields(header: Buffer, encoding: PreviewEncoding): DbfField[] {
    const fields: DbfField[] = [];
    for (let offset = 32; offset + 32 <= header.length; offset += 32) {
      if (header[offset] === 0x0d) break;
      const nameBuffer = header.subarray(offset, offset + 11);
      const zero = nameBuffer.indexOf(0);
      const rawName = zero >= 0 ? nameBuffer.subarray(0, zero) : nameBuffer;
      const name = this.decodeDbfText(rawName, encoding) || `FIELD_${fields.length + 1}`;
      fields.push({
        name,
        type: String.fromCharCode(header[offset + 11] || 0),
        length: header[offset + 16] || 0,
        decimalCount: header[offset + 17] || 0
      });
    }
    return fields;
  }

  private parseDbfRows(data: Buffer, fields: DbfField[], recordLength: number, encoding: PreviewEncoding): string[][] {
    const rows: string[][] = [];
    for (let offset = 0; offset + recordLength <= data.length; offset += recordLength) {
      const record = data.subarray(offset, offset + recordLength);
      if (record[0] === 0x2a) continue;
      let fieldOffset = 1;
      const row: string[] = [];
      for (const field of fields) {
        const raw = record.subarray(fieldOffset, fieldOffset + field.length);
        row.push(this.formatDbfValue(raw, field, encoding));
        fieldOffset += field.length;
      }
      rows.push(row);
    }
    return rows;
  }

  private formatDbfValue(raw: Buffer, field: DbfField, encoding: PreviewEncoding): string {
    const value = this.decodeDbfText(raw, encoding).trim();
    if (field.type === 'D' && /^\d{8}$/.test(value)) {
      return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
    if (field.type === 'L') {
      const normalized = value.toUpperCase();
      if (['Y', 'T'].includes(normalized)) return 'true';
      if (['N', 'F'].includes(normalized)) return 'false';
    }
    return value;
  }

  private decodeDbfText(raw: Buffer, encoding: PreviewEncoding): string {
    return encoding === 'gb2312' ? iconv.decode(raw, 'gb18030') : raw.toString('utf8');
  }

  private stat(remotePath: string): Promise<{ size: number; mtime: number }> {
    return new Promise((resolve, reject) => {
      this.sftp!.stat(remotePath, (error, attrs) => {
        if (error) reject(error);
        else resolve({ size: attrs.size, mtime: attrs.mtime });
      });
    });
  }

  private readRemoteBytes(remotePath: string, offset: number, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = this.sftp!.createReadStream(remotePath, { start: offset, end: Math.max(offset, offset + maxBytes - 1) });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  private ensureSftp(): void {
    if (!this.sftp) throw new Error(t(this.settings.language, 'transferNotConnected'));
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log(`${t(this.settings.language, 'error')}: ${message}`);
  }

  private post(message: Record<string, unknown>): void {
    void this.panel.webview.postMessage(message);
  }

  private log(text: string): void {
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    this.logLines.push(line);
    if (this.logLines.length > 1000) {
      this.logLines.splice(0, this.logLines.length - 1000);
    }
    this.post({ type: 'log', text: line, formatted: true });
  }

  private dispose(): void {
    this.disposeConnection();
  }

  private disposeConnection(): void {
    this.connected = false;
    this.sftp = undefined;
    this.client?.end();
    this.client = undefined;
  }

  private markClosed(text: string): void {
    if (this.connecting) return;
    if (!this.connected) return;
    this.connected = false;
    this.sftp = undefined;
    this.client = undefined;
    this.log(text);
  }

  private renderHtml(): string {
    const nonce = getNonce();
    const webview = this.panel.webview;
    const lang = this.settings.language;
    const defaultPreviewEncoding = this.server.encoding === 'gb18030' ? 'gb2312' : 'utf8';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { --log-height: 150px; margin: 0; height: 100vh; display: grid; grid-template-rows: auto minmax(120px, 1fr) 6px var(--log-height); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); overflow: hidden; }
    .toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) auto auto auto; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    input, select { min-width: 0; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 5px; font: inherit; }
    button { cursor: pointer; padding: 6px 9px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .45; cursor: default; }
    .list { min-height: 0; overflow: auto; }
    .row { display: grid; grid-template-columns: 28px minmax(180px, 1fr) 110px 165px; gap: 8px; align-items: center; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .row:not(.header) { cursor: default; }
    .row:not(.header):hover { background: rgba(75, 156, 255, .18); }
    .row.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground, #0e639c); }
    .row.selected:hover { background: var(--vscode-list-activeSelectionBackground, #0e639c); }
    .row.header { position: sticky; top: 0; z-index: 1; font-weight: 700; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder { cursor: pointer; }
    .folder .name { font-weight: 650; }
    .log-resizer { cursor: row-resize; background: var(--vscode-panel-border); }
    .log-resizer:hover { background: var(--vscode-focusBorder); }
    .log { min-height: 0; overflow: auto; padding: 8px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-foreground)); font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; outline: none; }
    .status { padding: 7px 8px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
    .preview { position: fixed; inset: 28px; display: none; min-height: 0; grid-template-rows: auto minmax(0, 1fr); z-index: 8; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
    .preview.open { display: grid; }
    .preview-bar { display: grid; grid-template-columns: minmax(120px, 1fr) auto auto auto auto; gap: 8px; align-items: center; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .preview-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .font-control { display: inline-grid; grid-template-columns: auto 42px auto; gap: 4px; align-items: center; }
    .font-control button { min-width: 26px; padding: 4px 7px; }
    .font-size { color: var(--vscode-descriptionForeground); text-align: center; font-size: 12px; }
    .code { overflow: auto; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: var(--preview-font-size, 12px); line-height: 1.35; }
    .code-line { display: grid; grid-template-columns: 54px minmax(0, 1fr); min-height: 18px; }
    .line-number { padding: 0 10px 0 6px; text-align: right; user-select: none; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background, var(--vscode-editor-background)); border-right: 1px solid var(--vscode-panel-border); }
    .line-code { padding: 0 10px; white-space: pre; }
    .tok-comment { color: var(--vscode-editorCodeLens-foreground); }
    .tok-string { color: var(--vscode-debugTokenExpression-string); }
    .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: 600; }
    .tok-type { color: var(--vscode-symbolIcon-structForeground, #4ec9b0); }
    .tok-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .tok-function { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
    .tok-preprocessor { color: var(--vscode-symbolIcon-operatorForeground, #c586c0); font-weight: 600; }
    .tok-tag { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
    .tok-attr { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .tok-section { color: var(--vscode-symbolIcon-classForeground, #267f99); font-weight: 700; }
    .tok-key { color: var(--vscode-symbolIcon-propertyForeground, #0451a5); font-weight: 600; }
    .tok-operator { color: var(--vscode-symbolIcon-operatorForeground, #000000); }
    .csv-table { width: max-content; min-width: 100%; border-collapse: collapse; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .csv-table th, .csv-table td { max-width: 320px; padding: 5px 8px; border: 1px solid var(--vscode-panel-border); white-space: pre-wrap; vertical-align: top; }
    .csv-table th { position: sticky; top: 0; z-index: 1; color: var(--vscode-editor-foreground); background: var(--vscode-sideBar-background); font-weight: 700; }
    .csv-table .row-index { position: sticky; left: 0; z-index: 2; min-width: 54px; max-width: 72px; text-align: right; color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background, var(--vscode-editor-background)); }
    .csv-table th.row-index { top: 0; z-index: 3; background: var(--vscode-sideBar-background); }
    .preview-note { padding: 6px 10px; color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); background: var(--vscode-editorWarning-background, var(--vscode-inputValidation-warningBackground, transparent)); border-bottom: 1px solid var(--vscode-panel-border); }
    .unsupported-preview { display: grid; place-items: center; min-height: 220px; padding: 24px; color: var(--vscode-descriptionForeground); font-size: 14px; text-align: center; }
    .modal { position: fixed; inset: 0; display: none; grid-template-rows: minmax(0, 1fr); padding: 18px; background: rgba(0,0,0,.42); z-index: 10; }
    .modal.open { display: grid; }
    .picker { display: grid; grid-template-rows: auto minmax(180px, 1fr); min-height: 0; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-editor-background); overflow: hidden; }
    .pickerbar { display: grid; grid-template-columns: minmax(160px, 1fr) auto auto auto auto; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .local-list { overflow: auto; }
    .context-menu { position: fixed; display: none; z-index: 20; min-width: 120px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 5px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 8px 24px rgba(0,0,0,.28); }
    .context-menu.open { display: block; }
    .context-item { padding: 6px 10px; border-radius: 3px; cursor: pointer; user-select: none; white-space: nowrap; }
    .context-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="path" value=".">
    <button id="refresh" title="${t(lang, 'refresh')}">↻</button>
    <button id="downloadSelected" title="${t(lang, 'download')}">↓</button>
    <button id="upload" title="${t(lang, 'upload')}">↑</button>
  </div>
  <div class="list" id="list"></div>
  <div id="preview" class="preview">
    <div class="preview-bar">
      <div id="previewTitle" class="preview-title"></div>
      <button id="toggleCsvView" style="display:none">${t(lang, 'tablePreview')}</button>
      <select id="previewEncoding" title="${t(lang, 'previewEncoding')}">
        <option value="utf8">UTF-8</option>
        <option value="gb2312">GB2312</option>
      </select>
      <div class="font-control" title="${t(lang, 'previewFontSize')}">
        <button id="previewFontDown">-</button>
        <span id="previewFontSize" class="font-size">12px</span>
        <button id="previewFontUp">+</button>
      </div>
      <button id="closePreview">${t(lang, 'close')}</button>
    </div>
    <div id="code" class="code"></div>
  </div>
  <div id="logResizer" class="log-resizer" title="${t(lang, 'resizeLog')}"></div>
  <div class="log" id="log"></div>
  <div id="logContextMenu" class="context-menu">
    <div id="copyLog" class="context-item">${t(lang, 'copy')}</div>
  </div>
  <div id="fileContextMenu" class="context-menu">
    <div id="menuDownload" class="context-item">${t(lang, 'download')}</div>
    <div id="menuUpload" class="context-item">${t(lang, 'upload')}</div>
    <div id="menuRefresh" class="context-item">${t(lang, 'refresh')}</div>
  </div>
  <div id="uploadContextMenu" class="context-menu">
    <div id="menuUploadSelected" class="context-item">${t(lang, 'upload')}</div>
  </div>
  <div id="uploadModal" class="modal">
    <div class="picker">
      <div class="pickerbar">
        <input id="localPath" value="">
        <button id="localUp" title="${t(lang, 'up')}">←</button>
        <button id="localRefresh" title="${t(lang, 'refresh')}">↻</button>
        <button id="confirmUpload" title="${t(lang, 'upload')}">↑</button>
        <button id="cancelUpload" title="${t(lang, 'cancel')}">×</button>
      </div>
      <div class="local-list" id="localList"></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let currentPath = '.';
    let entries = [];
    let selectedPaths = new Set();
    let localEntries = [];
    let selectedLocalPaths = new Set();
    let currentLocalPath = '';
    let currentPreviewPath = '';
    let currentPreviewEncoding = '${defaultPreviewEncoding}';
    let currentPreviewContent = '';
    let currentPreviewLanguage = 'text';
    let currentPreviewDone = true;
    let currentPreviewNextOffset = 0;
    let currentDbfNextRecord = 0;
    let currentPreviewLoading = false;
    let previewFontSize = 12;
    let pendingPreviewLine = '';
    let renderedPreviewLines = 0;
    let previewHighlightState = { blockComment: false };
    let csvTableMode = false;
    const logMenu = $('logContextMenu');
    const fileMenu = $('fileContextMenu');
    const uploadMenu = $('uploadContextMenu');
    function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }
    function hideMenus() {
      logMenu.classList.remove('open');
      fileMenu.classList.remove('open');
      uploadMenu.classList.remove('open');
    }
    function selectedUploadPaths() {
      return Array.from(selectedLocalPaths);
    }
    function selectedDownloadItems() {
      return entries
        .filter((entry) => selectedPaths.has(entry.path))
        .map((entry) => ({ path: entry.path, isDirectory: entry.type === 'directory' }));
    }
    function selectedTextWithin(element) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
      const range = selection.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return '';
      return selection.toString();
    }
    function applyPreviewFontSize() {
      $('code').style.setProperty('--preview-font-size', previewFontSize + 'px');
      $('previewFontSize').textContent = previewFontSize + 'px';
    }
    function parentPath(value) {
      const clean = value.replace(/\\/+$/, '');
      if (!clean || clean === '.' || clean === '/') return '.';
      const index = clean.lastIndexOf('/');
      if (index <= 0) return clean.startsWith('/') ? '/' : '.';
      return clean.slice(0, index);
    }
    function formatSize(size) {
      if (size < 1024) return size + ' B';
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
      if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
      return (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    }
    function extensionOf(name) {
      const clean = String(name || '').toLowerCase();
      const index = clean.lastIndexOf('.');
      return index >= 0 ? clean.slice(index) : '';
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function span(className, value) {
      return '<span class="' + className + '">' + escapeHtml(value) + '</span>';
    }
    function classifyWord(word, language, nextChar) {
      const keywordSet = new Set('alignas alignof and asm auto break case catch class concept constexpr consteval constinit continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern false for friend goto if import inline module mutable namespace new noexcept not nullptr operator private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union using virtual volatile while abstract assert boolean byte char const double extends final finally float implements import instanceof int interface long native new package private protected public return short static strictfp super synchronized throws transient var void yield let const function async await from in of'.split(' '));
      const typeSet = new Set('bool boolean byte char char8_t char16_t char32_t double float int int8_t int16_t int32_t int64_t long short signed size_t ssize_t string String std uint8_t uint16_t uint32_t uint64_t unsigned void wchar_t FILE auto'.split(' '));
      if (/^(0x[\\da-fA-F]+|0b[01]+|\\d+(\\.\\d+)?([eE][+-]?\\d+)?[uUlLfF]*)$/.test(word)) return span('tok-number', word);
      if (typeSet.has(word)) return span('tok-type', word);
      if (keywordSet.has(word)) return span('tok-keyword', word);
      if (nextChar === '(' && /^[A-Za-z_$][\\w$]*$/.test(word)) return span('tok-function', word);
      return escapeHtml(word);
    }
    function highlightPlain(value, language) {
      let result = '';
      const tokenRegex = /(0x[\\da-fA-F]+|0b[01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[uUlLfF]*|[A-Za-z_$][\\w$]*)/g;
      let last = 0;
      for (const match of value.matchAll(tokenRegex)) {
        const index = match.index || 0;
        result += escapeHtml(value.slice(last, index));
        const after = value.slice(index + match[0].length).match(/^\\s*(.)/);
        result += classifyWord(match[0], language, after ? after[1] : '');
        last = index + match[0].length;
      }
      result += escapeHtml(value.slice(last));
      return result;
    }
    function highlightCodePart(value, language) {
      const strings = /("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')/g;
      let result = '';
      let last = 0;
      for (const match of value.matchAll(strings)) {
        result += highlightPlain(value.slice(last, match.index), language);
        result += span('tok-string', match[0]);
        last = (match.index || 0) + match[0].length;
      }
      result += highlightPlain(value.slice(last), language);
      return result;
    }
    function splitLineComment(line, language) {
      if (language === 'python' || language === 'shell') {
        const hash = line.indexOf('#');
        return hash >= 0 ? [line.slice(0, hash), line.slice(hash)] : [line, ''];
      }
      const slash = line.indexOf('//');
      return slash >= 0 ? [line.slice(0, slash), line.slice(slash)] : [line, ''];
    }
    function highlightCStyleLine(line, language, state) {
      if (state.blockComment) {
        const end = line.indexOf('*/');
        if (end < 0) return span('tok-comment', line);
        state.blockComment = false;
        return span('tok-comment', line.slice(0, end + 2)) + highlightCStyleLine(line.slice(end + 2), language, state);
      }
      const blockStart = line.indexOf('/*');
      const lineComment = line.indexOf('//');
      const commentStart = blockStart >= 0 && (lineComment < 0 || blockStart < lineComment) ? blockStart : lineComment;
      if (commentStart >= 0) {
        const before = line.slice(0, commentStart);
        const comment = line.slice(commentStart);
        if (comment.startsWith('/*')) {
          const end = comment.indexOf('*/', 2);
          if (end < 0) {
            state.blockComment = true;
            return highlightCodePart(before, language) + span('tok-comment', comment);
          }
          return highlightCodePart(before, language) + span('tok-comment', comment.slice(0, end + 2)) + highlightCStyleLine(comment.slice(end + 2), language, state);
        }
        return highlightCodePart(before, language) + span('tok-comment', comment);
      }
      if (/^\\s*#\\s*\\w+/.test(line)) {
        const match = line.match(/^(\\s*#\\s*\\w+)(.*)$/);
        return match ? span('tok-preprocessor', match[1]) + highlightCodePart(match[2], language) : highlightCodePart(line, language);
      }
      return highlightCodePart(line, language);
    }
    function highlightLine(line, language, state) {
      if (language === 'ini') {
        if (/^\\s*[;#]/.test(line)) return span('tok-comment', line);
        const section = line.match(/^(\\s*)\\[([^\\]]+)\\](.*)$/);
        if (section) return escapeHtml(section[1]) + span('tok-section', '[' + section[2] + ']') + escapeHtml(section[3]);
        const pair = line.match(/^(\\s*)([^=:#\\s][^=:#]*?)(\\s*[=:])(.*)$/);
        if (pair) return escapeHtml(pair[1]) + span('tok-key', pair[2].trimEnd()) + escapeHtml(pair[2].slice(pair[2].trimEnd().length)) + span('tok-operator', pair[3]) + highlightCodePart(pair[4], 'text');
        return escapeHtml(line);
      }
      if (language === 'xml' || language === 'html') {
        const html = escapeHtml(line).replace(/([\\w:-]+)=(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="tok-attr">$1</span>=$2');
        return html.replace(/(&lt;\\/?[\\w:-]+)/g, '<span class="tok-tag">$1</span>');
      }
      if (['c','cpp','java','javascript','typescript','css'].includes(language)) {
        return highlightCStyleLine(line, language, state);
      }
      const parts = splitLineComment(line, language);
      return highlightCodePart(parts[0], language) + (parts[1] ? span('tok-comment', parts[1]) : '');
    }
    function parseCsv(content) {
      const rows = [];
      let row = [];
      let cell = '';
      let quoted = false;
      for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        if (quoted) {
          if (char === '"' && content[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else if (char === '"') {
            quoted = false;
          } else {
            cell += char;
          }
        } else if (char === '"') {
          quoted = true;
        } else if (char === ',') {
          row.push(cell);
          cell = '';
        } else if (char === '\\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
        } else if (char !== '\\r') {
          cell += char;
        }
      }
      row.push(cell);
      if (row.length > 1 || row[0]) rows.push(row);
      return rows;
    }
    function renderCsvTable(content) {
      const rows = parseCsv(content);
      if (!rows.length) return '<div class="unsupported-preview"></div>';
      const head = rows[0];
      let html = '<table class="csv-table"><thead><tr><th class="row-index">#</th>';
      for (const cell of head) html += '<th>' + escapeHtml(cell) + '</th>';
      html += '</tr></thead><tbody>';
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        html += '<tr><td class="row-index">' + rowIndex + '</td>';
        for (let index = 0; index < Math.max(row.length, head.length); index += 1) html += '<td>' + escapeHtml(row[index] || '') + '</td>';
        html += '</tr>';
      }
      return html + '</tbody></table>';
    }
    function renderDbfTable(fields, rows, startIndex = 1) {
      const headers = fields && fields.length ? fields.map((field) => field.name || '') : [];
      let html = '<table class="csv-table"><thead><tr><th class="row-index">#</th>';
      for (const header of headers) html += '<th>' + escapeHtml(header) + '</th>';
      html += '</tr></thead><tbody>';
      for (let rowIndex = 0; rowIndex < (rows || []).length; rowIndex += 1) {
        const row = rows[rowIndex];
        html += '<tr><td class="row-index">' + (startIndex + rowIndex) + '</td>';
        for (let index = 0; index < Math.max(row.length, headers.length); index += 1) html += '<td>' + escapeHtml(row[index] || '') + '</td>';
        html += '</tr>';
      }
      return html + '</tbody></table>';
    }
    function resetTextPreview() {
      $('code').innerHTML = '';
      pendingPreviewLine = '';
      renderedPreviewLines = 0;
      previewHighlightState = { blockComment: false };
    }
    function appendRenderedLines(lines, language) {
      const code = $('code');
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < lines.length; index += 1) {
        const line = document.createElement('div');
        line.className = 'code-line';
        const number = document.createElement('div');
        number.className = 'line-number';
        number.textContent = String(++renderedPreviewLines);
        const contentElement = document.createElement('div');
        contentElement.className = 'line-code';
        contentElement.innerHTML = highlightLine(lines[index], language || 'text', previewHighlightState) || ' ';
        line.append(number, contentElement);
        fragment.append(line);
      }
      code.append(fragment);
    }
    function appendTextPreviewChunk(content, language, done) {
      const normalized = String(content || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      const merged = pendingPreviewLine + normalized;
      const lines = merged.split('\\n');
      if (!done) {
        pendingPreviewLine = lines.pop() || '';
      } else {
        pendingPreviewLine = '';
      }
      if (!done && normalized.endsWith('\\n') && lines[lines.length - 1] === '') lines.pop();
      appendRenderedLines(lines, language);
    }
    function renderTextPreview(content, language, done = true) {
      resetTextPreview();
      appendTextPreviewChunk(content, language, done);
    }
    function addPreviewNote(text) {
      if (!text) return;
      const note = document.createElement('div');
      note.className = 'preview-note';
      note.textContent = text;
      $('code').prepend(note);
    }
    function resetPreviewScroll() {
      const code = $('code');
      code.scrollTop = 0;
      code.scrollLeft = 0;
      requestAnimationFrame(() => {
        code.scrollTop = 0;
        code.scrollLeft = 0;
      });
    }
    function renderPreview(message) {
      const code = $('code');
      if (message.unsupported) {
        code.innerHTML = '<div class="unsupported-preview">' + escapeHtml(message.message || '${t(lang, 'unsupportedBinaryPreview')}') + '</div>';
        $('previewTitle').textContent = message.path || message.name || '';
      currentPreviewPath = message.path || '';
      currentPreviewEncoding = message.encoding || currentPreviewEncoding;
      currentPreviewContent = '';
      currentPreviewLanguage = message.language || 'text';
      currentPreviewDone = true;
      currentPreviewNextOffset = 0;
      currentDbfNextRecord = 0;
      currentPreviewLoading = false;
      csvTableMode = false;
        $('toggleCsvView').style.display = 'none';
        $('previewEncoding').value = currentPreviewEncoding;
        $('preview').classList.add('open');
        resetPreviewScroll();
        return;
      }
      $('previewTitle').textContent = message.path || message.name || '';
      currentPreviewPath = message.path || '';
      currentPreviewEncoding = message.encoding || currentPreviewEncoding;
      currentPreviewContent = String(message.content || '');
      currentPreviewLanguage = message.language || 'text';
      currentPreviewDone = Boolean(message.done);
      currentPreviewNextOffset = Number(message.nextOffset) || 0;
      currentDbfNextRecord = 0;
      currentPreviewLoading = false;
      csvTableMode = false;
      $('toggleCsvView').style.display = currentPreviewLanguage === 'csv' ? '' : 'none';
      $('toggleCsvView').textContent = '${t(lang, 'tablePreview')}';
      $('previewEncoding').value = currentPreviewEncoding;
      renderTextPreview(currentPreviewContent, currentPreviewLanguage, currentPreviewDone);
      $('preview').classList.add('open');
      resetPreviewScroll();
    }
    function renderDbfPreview(message) {
      $('previewTitle').textContent = message.path || message.name || '';
      currentPreviewPath = message.path || '';
      currentPreviewEncoding = message.encoding || currentPreviewEncoding;
      currentPreviewContent = JSON.stringify({ fields: message.fields || [], rows: message.rows || [] });
      currentPreviewLanguage = 'dbf';
      currentPreviewDone = Boolean(message.done);
      currentDbfNextRecord = Number(message.nextRecord) || 0;
      currentPreviewLoading = false;
      csvTableMode = true;
      $('toggleCsvView').style.display = 'none';
      $('previewEncoding').value = currentPreviewEncoding;
      $('code').innerHTML = renderDbfTable(message.fields || [], message.rows || []);
      $('preview').classList.add('open');
      resetPreviewScroll();
    }
    function appendPreviewChunk(message) {
      if (message.path !== currentPreviewPath || message.encoding !== currentPreviewEncoding) return;
      currentPreviewLoading = false;
      currentPreviewDone = Boolean(message.done);
      currentPreviewNextOffset = Number(message.nextOffset) || currentPreviewNextOffset;
      currentPreviewContent += String(message.content || '');
      if (csvTableMode) $('code').innerHTML = renderCsvTable(currentPreviewContent);
      else appendTextPreviewChunk(message.content || '', currentPreviewLanguage, currentPreviewDone);
    }
    function appendDbfChunk(message) {
      if (message.path !== currentPreviewPath || message.encoding !== currentPreviewEncoding || currentPreviewLanguage !== 'dbf') return;
      currentPreviewLoading = false;
      currentPreviewDone = Boolean(message.done);
      const startIndex = currentDbfNextRecord + 1;
      currentDbfNextRecord = Number(message.nextRecord) || currentDbfNextRecord;
      const tableBody = $('code').querySelector('tbody');
      if (!tableBody) return;
      const fragment = document.createDocumentFragment();
      for (let rowIndex = 0; rowIndex < (message.rows || []).length; rowIndex += 1) {
        const row = message.rows[rowIndex];
        const tr = document.createElement('tr');
        const indexCell = document.createElement('td');
        indexCell.className = 'row-index';
        indexCell.textContent = String(startIndex + rowIndex);
        tr.append(indexCell);
        for (const cell of row) {
          const td = document.createElement('td');
          td.textContent = cell || '';
          tr.append(td);
        }
        fragment.append(tr);
      }
      tableBody.append(fragment);
    }
    function loadMorePreviewIfNeeded() {
      const code = $('code');
      if (!currentPreviewPath || currentPreviewDone || currentPreviewLoading) return;
      if (code.scrollTop + code.clientHeight < code.scrollHeight - 700) return;
      currentPreviewLoading = true;
      if (currentPreviewLanguage === 'dbf') {
        post('loadDbfChunk', { path: currentPreviewPath, encoding: currentPreviewEncoding, recordOffset: currentDbfNextRecord });
        return;
      }
      post('loadTextChunk', { path: currentPreviewPath, encoding: currentPreviewEncoding, offset: currentPreviewNextOffset });
    }
    function localParentPath(value) {
      if (!value) return '';
      const clean = value.replace(/[\\\\/]+$/, '');
      if (/^[A-Za-z]:$/.test(clean)) return '';
      const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\\\'));
      if (slash <= 0) return clean;
      return clean.slice(0, slash);
    }
    function render() {
      const list = $('list');
      list.innerHTML = '<div class="row header"><div></div><div>${t(lang, 'name')}</div><div>${t(lang, 'size')}</div><div>${t(lang, 'modified')}</div></div>';
      if (currentPath !== '.' && currentPath !== '/') list.append(row({ name: '..', path: parentPath(currentPath), type: 'directory', size: 0, modifiedAt: 0 }, true));
      for (const entry of entries) list.append(row(entry, false));
    }
    function row(entry, parent) {
      const div = document.createElement('div');
      div.className = 'row ' + (entry.type === 'directory' ? 'folder' : '');
      div.dataset.path = entry.path;
      if (selectedPaths.has(entry.path)) div.classList.add('selected');
      const icon = document.createElement('div');
      icon.textContent = entry.type === 'directory' ? '📁' : '📄';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = entry.name;
      name.title = entry.path;
      const size = document.createElement('div');
      size.textContent = entry.type === 'directory' ? '-' : formatSize(entry.size || 0);
      const modified = document.createElement('div');
      modified.textContent = entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '';
      div.onclick = (event) => {
        if (event.ctrlKey || event.metaKey) {
          if (selectedPaths.has(entry.path)) selectedPaths.delete(entry.path);
          else selectedPaths.add(entry.path);
        } else {
          selectedPaths = new Set([entry.path]);
        }
        render();
      };
      if (entry.type === 'directory') {
        div.ondblclick = () => post('list', { path: entry.path });
      } else if (entry.type === 'file' || entry.type === 'symlink') {
        div.ondblclick = () => post('openTextFile', { path: entry.path, encoding: currentPreviewEncoding });
      }
      div.append(icon, name, size, modified);
      return div;
    }
    function renderLocal() {
      const list = $('localList');
      list.innerHTML = '<div class="row header"><div></div><div>${t(lang, 'name')}</div><div>${t(lang, 'size')}</div><div>${t(lang, 'modified')}</div></div>';
      for (const entry of localEntries) {
        const div = document.createElement('div');
        div.className = 'row ' + (entry.type === 'directory' ? 'folder' : '');
        div.dataset.path = entry.path;
        if (selectedLocalPaths.has(entry.path)) div.classList.add('selected');
        const icon = document.createElement('div');
        icon.textContent = entry.type === 'directory' ? '📁' : '📄';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = entry.name;
        name.title = entry.path;
        const size = document.createElement('div');
        size.textContent = entry.type === 'directory' ? '-' : formatSize(entry.size || 0);
        const modified = document.createElement('div');
        modified.textContent = entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '';
        div.onclick = (event) => {
          if (event.ctrlKey || event.metaKey) {
            if (selectedLocalPaths.has(entry.path)) selectedLocalPaths.delete(entry.path);
            else selectedLocalPaths.add(entry.path);
          } else {
            selectedLocalPaths = new Set([entry.path]);
          }
          renderLocal();
        };
        if (entry.type === 'directory') {
          div.ondblclick = () => post('listLocal', { path: entry.path });
        }
        div.append(icon, name, size, modified);
        list.append(div);
      }
    }
    $('path').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') post('list', { path: $('path').value || currentPath });
    });
    $('refresh').onclick = () => post('refresh');
    $('upload').onclick = () => post('upload');
    $('downloadSelected').onclick = () => post('downloadMany', { items: selectedDownloadItems() });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'list') {
        currentPath = message.path || '.';
        entries = message.entries || [];
        selectedPaths = new Set();
        $('path').value = currentPath;
        render();
      }
      if (message.type === 'logSnapshot') {
        $('log').textContent = (message.lines || []).join('\\n') + ((message.lines || []).length ? '\\n' : '');
        $('log').scrollTop = $('log').scrollHeight;
      }
      if (message.type === 'status') appendLog(message.text || '');
      if (message.type === 'localList') {
        currentLocalPath = message.path || '';
        localEntries = message.entries || [];
        selectedLocalPaths = new Set();
        $('localPath').value = currentLocalPath;
        $('uploadModal').classList.add('open');
        renderLocal();
      }
      if (message.type === 'textPreview') renderPreview(message);
      if (message.type === 'textChunk') appendPreviewChunk(message);
      if (message.type === 'dbfPreview') renderDbfPreview(message);
      if (message.type === 'dbfChunk') appendDbfChunk(message);
      if (message.type === 'log') {
        appendLog(message.text || '', Boolean(message.formatted));
      }
    });
    function appendLog(text, formatted = false) {
      const log = $('log');
      if (formatted) log.textContent += text + '\\n';
      else {
        const time = new Date().toLocaleTimeString();
        log.textContent += '[' + time + '] ' + text + '\\n';
      }
      log.scrollTop = log.scrollHeight;
    }
    $('localPath').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') post('listLocal', { path: $('localPath').value });
    });
    $('previewEncoding').value = currentPreviewEncoding;
    $('previewEncoding').onchange = () => {
      currentPreviewEncoding = $('previewEncoding').value;
      if (currentPreviewPath) post('openTextFile', { path: currentPreviewPath, encoding: currentPreviewEncoding });
    };
    $('toggleCsvView').onclick = () => {
      if (currentPreviewLanguage !== 'csv') return;
      csvTableMode = !csvTableMode;
      $('toggleCsvView').textContent = csvTableMode ? '${t(lang, 'textPreview')}' : '${t(lang, 'tablePreview')}';
      if (csvTableMode) $('code').innerHTML = renderCsvTable(currentPreviewContent);
      else renderTextPreview(currentPreviewContent, currentPreviewLanguage, currentPreviewDone);
    };
    $('previewFontDown').onclick = () => {
      previewFontSize = Math.max(8, previewFontSize - 1);
      applyPreviewFontSize();
    };
    $('previewFontUp').onclick = () => {
      previewFontSize = Math.min(24, previewFontSize + 1);
      applyPreviewFontSize();
    };
    $('code').addEventListener('scroll', loadMorePreviewIfNeeded);
    $('closePreview').onclick = () => $('preview').classList.remove('open');
    $('localUp').onclick = () => post('listLocal', { path: localParentPath(currentLocalPath) });
    $('localRefresh').onclick = () => post('listLocal', { path: currentLocalPath });
    $('cancelUpload').onclick = () => $('uploadModal').classList.remove('open');
    $('confirmUpload').onclick = () => {
      post('uploadLocal', { paths: Array.from(selectedLocalPaths) });
      $('uploadModal').classList.remove('open');
    };
    document.addEventListener('contextmenu', (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        hideMenus();
        return;
      }
      event.preventDefault();
      if ($('log').contains(target)) {
        logMenu.style.left = Math.min(event.clientX, window.innerWidth - 140) + 'px';
        logMenu.style.top = Math.min(event.clientY, window.innerHeight - 48) + 'px';
        logMenu.classList.add('open');
        fileMenu.classList.remove('open');
      } else if ($('list').contains(target)) {
        const row = target.closest('.row:not(.header)');
        if (row && row.dataset.path && !selectedPaths.has(row.dataset.path)) {
          selectedPaths = new Set([row.dataset.path]);
          render();
        }
        fileMenu.style.left = Math.min(event.clientX, window.innerWidth - 170) + 'px';
        fileMenu.style.top = Math.min(event.clientY, window.innerHeight - 112) + 'px';
        fileMenu.classList.add('open');
        logMenu.classList.remove('open');
        uploadMenu.classList.remove('open');
      } else if ($('localList').contains(target)) {
        const row = target.closest('.row:not(.header)');
        if (row && row.dataset.path && !selectedLocalPaths.has(row.dataset.path)) {
          selectedLocalPaths = new Set([row.dataset.path]);
          renderLocal();
        }
        uploadMenu.style.left = Math.min(event.clientX, window.innerWidth - 140) + 'px';
        uploadMenu.style.top = Math.min(event.clientY, window.innerHeight - 48) + 'px';
        uploadMenu.classList.add('open');
        logMenu.classList.remove('open');
        fileMenu.classList.remove('open');
      } else {
        hideMenus();
      }
    });
    $('copyLog').onclick = () => {
      const selected = selectedTextWithin($('log'));
      post('copyText', { text: selected || $('log').textContent || '' });
      hideMenus();
    };
    $('menuUpload').onclick = () => { post('upload'); hideMenus(); };
    $('menuDownload').onclick = () => { post('downloadMany', { items: selectedDownloadItems() }); hideMenus(); };
    $('menuRefresh').onclick = () => { post('refresh'); hideMenus(); };
    $('menuUploadSelected').onclick = () => {
      post('uploadLocal', { paths: selectedUploadPaths() });
      $('uploadModal').classList.remove('open');
      hideMenus();
    };
    document.addEventListener('click', hideMenus);
    window.addEventListener('blur', hideMenus);
    let resizingLog = false;
    $('logResizer').addEventListener('mousedown', () => { resizingLog = true; });
    window.addEventListener('mouseup', () => { resizingLog = false; });
    window.addEventListener('mousemove', (event) => {
      if (!resizingLog) return;
      const height = Math.max(90, Math.min(window.innerHeight - 120, window.innerHeight - event.clientY));
      document.body.style.setProperty('--log-height', height + 'px');
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') $('preview').classList.remove('open');
    });
    applyPreviewFontSize();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function normalizeServer(input: Partial<ServerConfig>): ServerConfig {
  const host = safeString(input.host, '');
  const username = safeString(input.username, '');
  if (!host || !username) {
    throw new Error('Host and user are required.');
  }
  const server: ServerConfig = {
    id: safeString(input.id, makeId()),
    name: safeString(input.name, host),
    host,
    port: Number(input.port) || 22,
    username,
    authType: normalizeAuthType(input),
    encoding: normalizeEncoding(input.encoding)
  };
  if (input.encryptedPassword) {
    server.encryptedPassword = input.encryptedPassword;
  }
  if (input.privateKeyPath) {
    server.privateKeyPath = safeString(input.privateKeyPath, '');
  }
  if (input.encryptedPrivateKeyPassphrase) {
    server.encryptedPrivateKeyPassphrase = input.encryptedPrivateKeyPassphrase;
  }
  return server;
}

function normalizeAuthType(input: Partial<ServerConfig>): AuthType {
  if (input.authType === 'privateKey' || input.privateKeyPath) {
    return 'privateKey';
  }
  return 'password';
}

function defaultConfig(): AppConfig {
  return {
    settings: { language: 'en-US', showHiddenFiles: false },
    groups: [{ id: defaultGroupId, name: 'Default Group', servers: [] }]
  };
}

function normalizeConfig(input?: Partial<AppConfig>): AppConfig {
  const settings = normalizeSettings(input?.settings);
  const groups = Array.isArray(input?.groups) && input.groups.length
    ? input.groups.map((group) => ({
      id: safeString(group.id, makeId()),
      name: safeString(group.name, t(settings.language, 'defaultGroup')),
      servers: Array.isArray(group.servers) ? group.servers.map((server) => normalizeServer(server)) : []
    }))
    : [{ id: defaultGroupId, name: t(settings.language, 'defaultGroup'), servers: [] }];
  return { settings, groups };
}

function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
  return {
    language: input?.language === 'zh-CN' ? 'zh-CN' : 'en-US',
    showHiddenFiles: input?.showHiddenFiles === true
  };
}

function vsCodeLanguage(): Language {
  return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function t(language: Language, key: string, arg?: string): string {
  const table: Record<Language, Record<string, string>> = {
    'zh-CN': {
      addGroup: '添加分组',
      groupNamePrompt: '请输入分组名称',
      newGroup: '新分组',
      renameGroup: '重命名分组',
      newGroupNamePrompt: '请输入新的分组名称',
      delete: '删除',
      deleteGroupConfirm: `确定删除分组 "${arg ?? ''}"？其中的服务器配置也会被删除。`,
      deleteServerConfirm: `确定删除服务器 "${arg ?? ''}"？`,
      defaultGroup: '默认分组',
      passwordRequired: '请输入登录密码',
      privateKeyRequired: '请填写私钥路径',
      connecting: '正在连接',
      connected: '连接成功',
      connectionClosedRetryEnter: '连接已关闭。按 Enter 可尝试重连。',
      sshClosedRetryEnter: 'SSH 连接已关闭。按 Enter 可尝试重连。',
      connectFailed: '连接失败',
      fileTransfer: '文件传输',
      readyConnect: '准备连接...',
      connectingTransfer: '正在连接文件传输通道...',
      transferConnected: '文件传输已连接。',
      transferClosedRetry: '文件传输已关闭。刷新或在地址栏按 Enter 可尝试重连。',
      refresh: '刷新',
      upload: '上传',
      download: '下载',
      downloadSelected: '下载选中',
      up: '上级',
      pickerHint: '单击选择，Ctrl 单击多选，双击文件夹进入。',
      uploadSelected: '上传选中',
      cancel: '取消',
      name: '名称',
      size: '大小',
      modified: '最后修改时间',
      selectUploadItems: '请选择要上传的文件或文件夹。',
      startUpload: '开始上传',
      uploadingFile: '正在上传文件',
      fileUploadDone: '文件上传完成',
      uploadDone: '上传完成',
      selectDownloadItems: '请先选择要下载的文件或文件夹。',
      selectDownloadFolder: '选择下载保存目录',
      downloading: '正在下载',
      downloadDone: '下载完成',
      downloadingFile: '正在下载文件',
      fileDownloadDone: '文件下载完成',
      transferNotConnected: '文件传输尚未连接。',
      unsupportedPreview: '不支持预览该文件类型。',
      unsupportedBinaryPreview: '二进制文件不支持文本预览。',
      previewing: '正在预览',
      previewTooLarge: '文件超过 5 MB，已停止预览。',
      previewTruncated: '文件较大，仅预览前 1 MB 内容。',
      previewCacheHit: '使用本地缓存',
      previewEncoding: '预览编码',
      previewFontSize: '预览字体大小',
      tablePreview: '表格预览',
      textPreview: '文本预览',
      invalidDbfFile: '无效的 DBF 文件。',
      close: '关闭',
      copy: '复制',
      copySession: '复制会话',
      renameSession: '修改会话名',
      sessionNamePrompt: '请输入新的会话标签名',
      noActiveSession: '当前没有活动的 tshell 会话。',
      error: '错误',
      resizeLog: '拖拽调整日志高度'
    },
    'en-US': {
      addGroup: 'Add Group',
      groupNamePrompt: 'Enter group name',
      newGroup: 'New Group',
      renameGroup: 'Rename Group',
      newGroupNamePrompt: 'Enter new group name',
      delete: 'Delete',
      deleteGroupConfirm: `Delete group "${arg ?? ''}" and all servers in it?`,
      deleteServerConfirm: `Delete server "${arg ?? ''}"?`,
      defaultGroup: 'Default Group',
      passwordRequired: 'Enter login password',
      privateKeyRequired: 'Enter private key path',
      connecting: 'Connecting',
      connected: 'Connected',
      connectionClosedRetryEnter: 'Connection closed. Press Enter to retry.',
      sshClosedRetryEnter: 'SSH connection closed. Press Enter to retry.',
      connectFailed: 'Connection failed',
      fileTransfer: 'File Transfer',
      readyConnect: 'Ready to connect...',
      connectingTransfer: 'Connecting file transfer channel...',
      transferConnected: 'File transfer connected.',
      transferClosedRetry: 'File transfer closed. Refresh or press Enter in the path bar to retry.',
      refresh: 'Refresh',
      upload: 'Upload',
      download: 'Download',
      downloadSelected: 'Download Selected',
      up: 'Up',
      pickerHint: 'Click to select, Ctrl-click for multiple, double-click a folder to open.',
      uploadSelected: 'Upload Selected',
      cancel: 'Cancel',
      name: 'Name',
      size: 'Size',
      modified: 'Last Modified',
      selectUploadItems: 'Select files or folders to upload.',
      startUpload: 'Start upload',
      uploadingFile: 'Uploading file',
      fileUploadDone: 'File upload complete',
      uploadDone: 'Upload complete',
      selectDownloadItems: 'Select files or folders to download first.',
      selectDownloadFolder: 'Select download destination',
      downloading: 'Downloading',
      downloadDone: 'Download complete',
      downloadingFile: 'Downloading file',
      fileDownloadDone: 'File download complete',
      transferNotConnected: 'File transfer is not connected.',
      unsupportedPreview: 'This file type cannot be previewed.',
      unsupportedBinaryPreview: 'Binary files cannot be previewed as text.',
      previewing: 'Previewing',
      previewTooLarge: 'File is larger than 5 MB. Preview stopped.',
      previewTruncated: 'Large file: showing the first 1 MB only.',
      previewCacheHit: 'loaded from local cache',
      previewEncoding: 'Preview encoding',
      previewFontSize: 'Preview font size',
      tablePreview: 'Table Preview',
      textPreview: 'Text Preview',
      invalidDbfFile: 'Invalid DBF file.',
      close: 'Close',
      copy: 'Copy',
      copySession: 'Copy Session',
      renameSession: 'Rename Session',
      sessionNamePrompt: 'Enter a new session tab name',
      noActiveSession: 'No active tshell session.',
      error: 'Error',
      resizeLog: 'Drag to resize log'
    }
  };
  return table[language]?.[key] ?? table['en-US'][key] ?? table['zh-CN'][key] ?? key;
}

function isTextPreviewFile(remotePath: string): boolean {
  const extension = path.posix.extname(remotePath).toLowerCase();
  return new Set([
    '.h', '.hpp', '.c', '.cc', '.cpp', '.cxx', '.java', '.txt', '.ini', '.xml',
    '.json', '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.htm', '.md', '.py',
    '.sh', '.yml', '.yaml', '.log', '.conf', '.properties'
  ]).has(extension);
}

function previewLanguage(remotePath: string): string {
  const extension = path.posix.extname(remotePath).toLowerCase();
  if (extension === '.dbf') return 'dbf';
  if (['.xml', '.html', '.htm'].includes(extension)) return extension.slice(1);
  if (['.ini', '.conf', '.cfg', '.properties', '.env'].includes(extension)) return 'ini';
  if (extension === '.csv') return 'csv';
  if (['.c', '.h'].includes(extension)) return 'c';
  if (['.cc', '.cpp', '.cxx', '.hpp'].includes(extension)) return 'cpp';
  if (['.java'].includes(extension)) return 'java';
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  if (['.js', '.jsx'].includes(extension)) return 'javascript';
  if (['.css'].includes(extension)) return 'css';
  if (['.py'].includes(extension)) return 'python';
  if (['.sh'].includes(extension)) return 'shell';
  return 'text';
}

function isDbfFile(remotePath: string): boolean {
  return path.posix.extname(remotePath).toLowerCase() === '.dbf';
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (!buffer.length) {
    return false;
  }
  const sampleLength = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const value = buffer[index];
    if (value === 0) {
      return true;
    }
    if (value < 7 || (value > 14 && value < 32)) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength > 0.08;
}

function normalizePreviewEncoding(value: string, fallback: TerminalEncoding): PreviewEncoding {
  if (value.toLowerCase() === 'gb2312' || value.toLowerCase() === 'gbk' || value.toLowerCase() === 'gb18030') {
    return 'gb2312';
  }
  if (value.toLowerCase() === 'utf8' || value.toLowerCase() === 'utf-8') {
    return 'utf8';
  }
  return fallback === 'gb18030' ? 'gb2312' : 'utf8';
}

function normalizeEncoding(encoding?: string): TerminalEncoding {
  return encoding === 'gb18030' ? 'gb18030' : 'utf-8';
}

function toDownloadItems(value: unknown): DownloadRequestItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const candidate = item as Record<string, unknown>;
      const remotePath = typeof candidate.path === 'string' ? candidate.path : '';
      if (!remotePath) {
        return undefined;
      }
      return { path: remotePath, isDirectory: Boolean(candidate.isDirectory) };
    })
    .filter((item): item is DownloadRequestItem => Boolean(item));
}

function toLocalPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  const driveMatch = /^([a-zA-Z]):[\\/]?$/.exec(trimmed);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\`;
  }
  return path.normalize(trimmed);
}

async function listWindowsDrives(): Promise<LocalEntry[]> {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', type: 'directory', size: 0, modifiedAt: 0 }];
  }
  const entries: LocalEntry[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const drivePath = `${letter}:\\`;
    try {
      await fs.promises.access(drivePath);
      entries.push({ name: `${letter}:`, path: drivePath, type: 'directory', size: 0, modifiedAt: 0 });
    } catch {
      // Drive is not available.
    }
  }
  return entries;
}

function safeString(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function joinRemote(base: string, name: string): string {
  const cleanBase = base.trim() || '.';
  if (cleanBase === '/') return `/${name}`;
  if (cleanBase === '.') return name;
  return `${cleanBase.replace(/\/+$/, '')}/${name}`;
}

function basenameRemote(remotePath: string): string {
  const clean = remotePath.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index >= 0 ? clean.slice(index + 1) : clean;
}

function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
