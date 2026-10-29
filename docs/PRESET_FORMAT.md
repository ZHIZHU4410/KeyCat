# input-overlay 5.x 预设格式

KeyCat 直接读取 [univrsal/input-overlay](https://github.com/univrsal/input-overlay) v5.0.x 的 layout JSON 与配套 PNG 图集，不需要转换。这里记录引擎实际实现的那部分语义，方便自己改预设或排查渲染问题。

## 文件结构

一个预设 = 一份 layout JSON + 一张图集 PNG，放在同一个文件夹里：

```
wasd/
├─ wasd-minimal.json   # 布局
└─ wasd.png            # 图集（所有帧拼在一张图里）
```

## 顶层字段

| 字段 | 说明 |
| --- | --- |
| `overlay_width` / `overlay_height` | 画布尺寸（像素），预设摆放与命中框都按它算 |
| `elements` | 元素数组 |
| `flags` | 位标记：`1` 左摇杆、`2` 右摇杆、`4` 手柄、`8` 鼠标（仅作提示，不影响渲染） |
| `default_width` / `default_height` / `space_h` / `space_v` | 预设编辑器用的排版参数，渲染时忽略 |

## 元素通用字段

```json
{
  "id": "space",
  "type": 1,
  "code": 57,
  "mapping": [1301, 1, 421, 128],
  "pos": [137, 266],
  "z_level": 1
}
```

- `mapping`：`[u, v, w, h]`，源图集里的帧矩形（左上角 + 宽高）。
- `pos`：`[x, y]`，画到画布上的位置。
- `z_level`：绘制顺序，小的先画（稳定的升序排序）。

## 图集帧的排布约定

同一个元素的其它状态帧都在图集里，**间隔固定 3px**（input-overlay 的 `CFG_INNER_BORDER`）：

| 帧 | 位置 |
| --- | --- |
| 基础帧 | `(u, v)` |
| 按下态 / 第二行帧 | `(u, v + h + 3)` |
| 横向第 n 帧（滚轮、手柄编号、十字键） | `(u + (w + 3) * n, v)` |

如果某帧超出了图集范围（有些预设只画了基础帧），渲染时会自动回退到基础帧，不会出现元素消失。

## 元素类型

| `type` | 名称 | 额外字段 | 行为 |
| --- | --- | --- | --- |
| 0 | 静态贴图 | — | 只画基础帧 |
| 1 | 键盘按键 | `code` = libuiohook VC 码 | 按下时画 `v + h + 3` |
| 2 | 手柄按键 | `code` = SDL / 扩展键码 | 同上 |
| 3 | 鼠标按键 | `code`：1 左、2 右、3 中、4/5 侧键 | 同上 |
| 4 | 滚轮 | — | 中键按下 → `u + (w+3)`；上滚 → `u + 2(w+3)`；下滚 → `u + 3(w+3)`，滚动后 180ms 内显示 |
| 5 | 摇杆 | `side`（0 左 / 1 右）、`stick_radius` | 位置偏移 = 轴值 × `stick_radius`，按下摇杆（L3/R3）画高亮帧 |
| 6 | 扳机 | `side`、`trigger_mode`、`direction` | `trigger_mode` 为真时按 0.2 阈值切高亮帧；否则按进度填充，`direction`：1 上、2 下、3 左、4 右 |
| 7 | 手柄编号 | — | 按 `pad.index` 取 `u + (w+3)*index`，按下 Home 键再叠第 5 帧 |
| 8 | 十字键 | — | 9 帧：0 中心、1 左、2 右、3 上、4 下、5 左上、6 右上、7 左下、8 右下 |
| 9 | 鼠标移动 | `mouse_type`（0 光点 / 1 箭头）、`mouse_radius` | 光点按位移方向在 `±radius` 内偏移；箭头按移动方向旋转（图集里箭头默认朝上），圆心在 `pos - (w/2, -h/2)`，即左上角画在 `(pos.x - w, pos.y)` |

## 键码

- 键盘：直接用 libuiohook 的虚拟码，例如 `16` = Q、`30` = A、`57` = 空格、`42` = 左 Shift、`57416` = ↑。和 Windows 扫描码不同，不要自己换算。
- 手柄：`0~16` 是 SDL GameController 顺序（0=A、1=B、2=X、3=Y、4=Back、6=Start、9=LB、10=RB、11=↑…），
  部分预设（GameCube）用 `60416+` 的扩展码，引擎会统一映射到 Gamepad API 顺序。
- 鼠标：`1` 左键、`2` 右键、`3` 中键、`4` / `5` 侧键。

## 自己做一个预设

1. 在 Aseprite / Photoshop 里画一套“未按下 / 按下”两行图集，帧之间留 3px 间距。
2. 照上面的格式写 JSON，`mapping` 指到每个键的基础帧。
3. 放进 `presets/<名字>/`，或用户目录 `%APPDATA%\KeyCat\presets/<名字>/`。
4. 运行 `npm run check` 校验，或 `npm run preview -- --preset=<id> --pressed` 直接出图检查。
