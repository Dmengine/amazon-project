import QRCode from 'qrcode';

// Error correction "M" survives smudges and print wear; a 2-module quiet zone keeps scanners happy
// while staying compact enough to embed.
const OPTIONS = { errorCorrectionLevel: 'M', margin: 2 };

export function qrSvg(text) {
  return QRCode.toString(text, { ...OPTIONS, type: 'svg' });
}

export function qrPng(text, size = 512) {
  const width = Math.min(Math.max(Number(size) || 512, 128), 2048);
  return QRCode.toBuffer(text, { ...OPTIONS, type: 'png', width });
}
