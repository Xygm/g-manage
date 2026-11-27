import jsQR from "jsqr";

// 从验证器二维码里读出 2FA 密钥。只认 Google 身份验证器那一种：SHA1、6 位、30 秒。
// 算法限制与后端 parseTotpSecret 一致，填进表单后保存不会再被拒。

const emailInLabel = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const base32Secret = /^[A-Z2-7]+$/;
const imageName = /\.(png|jpe?g|gif|webp|bmp)$/i;
// 整页截图里二维码往往很小，原图认不出就按长边缩小再试。
const retryLongestSide = [1400, 800];
const minSecretLen = 16;
const maxSecretLen = 128;

const notTotp = "这个二维码不是验证器密钥";

export type TotpQr =
  | { ok: true; secret: string; email?: string }
  | { ok: false; error: string };

/** 从 otpauth:// 链接或裸 Base32 文本里取出规范化的 2FA 密钥。 */
export function secretFromQrText(raw: string): TotpQr {
  const text = raw.trim();
  if (!text) return { ok: false, error: notTotp };
  if (text.toLowerCase().startsWith("otpauth://")) return secretFromOtpauth(text);
  const secret = normalizeSecret(text);
  return secret ? { ok: true, secret } : { ok: false, error: notTotp };
}

function secretFromOtpauth(text: string): TotpQr {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: notTotp };
  }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") return { ok: false, error: notTotp };
  const unsupported = unsupportedTotp(url);
  if (unsupported) return { ok: false, error: unsupported };
  const secret = normalizeSecret(url.searchParams.get("secret") ?? "");
  if (!secret) return { ok: false, error: "2FA 密钥不是有效的 Base32（只含 A-Z 和 2-7）" };
  const email = emailFromLabel(url.pathname);
  return email ? { ok: true, secret, email } : { ok: true, secret };
}

function unsupportedTotp(url: URL): string | null {
  const alg = url.searchParams.get("algorithm");
  if (alg && alg.toUpperCase() !== "SHA1") return `暂不支持 ${alg} 算法的 2FA，只支持 SHA1`;
  const digits = url.searchParams.get("digits");
  if (digits && digits !== "6") return `暂不支持 ${digits} 位验证码的 2FA，只支持 6 位`;
  const period = url.searchParams.get("period");
  if (period && period !== "30") return `暂不支持 ${period} 秒刷新的 2FA，只支持 30 秒`;
  return null;
}

function normalizeSecret(raw: string): string | null {
  const s = raw.replace(/[\s=-]/g, "").toUpperCase();
  if (s.length < minSecretLen || s.length > maxSecretLen || !base32Secret.test(s)) return null;
  return s;
}

function emailFromLabel(pathname: string): string | undefined {
  const raw = pathname.replace(/^\//, "");
  let label = raw;
  try {
    label = decodeURIComponent(raw);
  } catch {
    // pathname 已经解码过，里面的 % 不是转义。
  }
  return label.match(emailInLabel)?.[0].toLowerCase();
}

export function transferHasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types).includes("Files");
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith("image/") || imageName.test(file.name);
}

/** 从拖放或粘贴里取出第一张图片。资源管理器拖进来时类型可能是空的，靠扩展名认。 */
export function imageFileFromTransfer(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && looksLikeImage(file)) return file;
  }
  for (const file of data.files) {
    if (looksLikeImage(file)) return file;
  }
  return null;
}

/** 在图片里找二维码。先认原图，认不出再缩小，适配整页截图里的小码。 */
export async function decodeQrImage(file: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const direct = readQr(bitmap, bitmap.width, bitmap.height);
    if (direct) return direct;
    const longest = Math.max(bitmap.width, bitmap.height);
    for (const maxSide of retryLongestSide) {
      if (longest <= maxSide) continue;
      const scale = maxSide / longest;
      const text = readQr(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
      if (text) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

function readQr(bitmap: ImageBitmap, width: number, height: number): string | null {
  if (width < 1 || height < 1) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  return jsQR(pixels.data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
