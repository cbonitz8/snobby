export class Notice {
  constructor(_message: string) {}
}

export class Plugin {}
export class Modal {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class TFile {}

export function normalizePath(path: string) {
  return path;
}

export function requestUrl(_options: unknown) {
  return Promise.resolve({ status: 200, json: {} });
}
