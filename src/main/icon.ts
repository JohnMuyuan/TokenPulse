import { app, nativeImage } from "electron";
import path from "path";

/**
 * 图标文件由 `npm run icons`（scripts/make-icon.cjs）生成到 packaging/。
 * 打包后 electron-builder 把 packaging/ 原样带进 resources/，所以两种情况路径不同。
 */
function iconPath(name: string) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "packaging")
    : path.join(__dirname, "..", "..", "packaging");
  return path.join(base, name);
}

export function windowIcon() {
  return nativeImage.createFromPath(iconPath("icon.png"));
}

/**
 * 托盘图标用 32×32 的白色线稿。
 * macOS 上标成 template image，系统会按菜单栏的明暗自动反色。
 */
export function trayIcon() {
  const image = nativeImage.createFromPath(iconPath("tray.png"));
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}
