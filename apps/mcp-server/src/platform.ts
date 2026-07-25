export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}
