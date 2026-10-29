/** 把 engine 产出的绘制指令画到 Canvas2D 上 */
export class CanvasPainter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  paint(commands) {
    const ctx = this.ctx;
    for (const cmd of commands) {
      const img = cmd.texture;
      if (!img || !img.complete || img.naturalWidth === 0) continue;

      if (cmd.rotation) {
        const px = cmd.pivotX ?? cmd.dw / 2;
        const py = cmd.pivotY ?? cmd.dh / 2;
        ctx.save();
        ctx.translate(cmd.dx + px, cmd.dy + py);
        ctx.rotate(cmd.rotation);
        ctx.drawImage(img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, -px, -py, cmd.dw, cmd.dh);
        ctx.restore();
      } else {
        ctx.drawImage(img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, cmd.dx, cmd.dy, cmd.dw, cmd.dh);
      }
    }
  }
}
