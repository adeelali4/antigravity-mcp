/** Low-level pixel-art helpers: everything snaps to integer coordinates, no smoothing, no gradients. */

export function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function pxStroke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  lineWidth = 1
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
}

export function pxCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(Math.round(cx), Math.round(cy), r, 0, Math.PI * 2);
  ctx.fill();
}

export function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 11,
  align: CanvasTextAlign = "center",
  weight: "normal" | "bold" = "bold"
) {
  ctx.font = `${weight} ${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, Math.round(x), Math.round(y));
}

/** A small rounded pill background behind text, for name tags and task labels. */
export function labelPill(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  fg: string,
  bg: string,
  size = 10
) {
  ctx.font = `bold ${size}px "Courier New", monospace`;
  const w = ctx.measureText(text).width + 12;
  const h = size + 8;
  const x = cx - w / 2;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y - h / 2, w, h, 4);
  ctx.fill();
  label(ctx, text, cx, y + 1, fg, size);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
