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
  const ico = nativeImage.createFromPath(iconPath("icon.ico"));
  return ico.isEmpty() ? nativeImage.createFromPath(iconPath("icon.png")) : ico;
}

/**
 * 托盘图标。
 * - macOS：白色线稿标成 template image，系统按菜单栏明暗自动反色；
 * - Windows / Linux：彩色底块。以前也用白色透明线稿，Windows 浅色任务栏上几乎看不见。
 *   托盘在 100% 缩放下是 16px、200% 是 32px，两种尺寸都放进去让系统挑，免得缩放发糊。
 */
export function trayIcon() {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromPath(iconPath("tray.png"));
    image.setTemplateImage(true);
    return image;
  }
  const image = nativeImage.createFromPath(iconPath("tray-color-16.png"));
  const large = nativeImage.createFromPath(iconPath("tray-color.png"));
  if (!large.isEmpty()) image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: large.toPNG() });
  return image.isEmpty() ? large : image;
}
