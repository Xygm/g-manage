//go:build ignore

// mkicon 生成 macOS 应用图标原图（1024px PNG）：圆角方块蓝色渐变 + 白色盾牌对勾。
// 用法：go run tools/mkicon/main.go <输出目录>，输出 <输出目录>/icon_1024.png。
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const (
	n      = 1024
	ss     = 4           // 每个像素 4x4 超采样抗锯齿
	inset  = 0.10 * n    // 四周留白（macOS 图标网格）
	body   = n - 2*inset // 方块边长
	radius = 0.22 * body // 圆角半径
	shadow = 0.035 * n   // 阴影扩散距离
	shOffY = 0.012 * n   // 阴影下移
)

var (
	top    = [3]float64{0x3B, 0x8B, 0xFF}
	bottom = [3]float64{0x0A, 0x6C, 0xFF}
)

// roundRectDist 返回点到圆角方块边缘的有向距离（内部为负）。
func roundRectDist(x, y float64) float64 {
	c := inset + body/2
	qx := math.Abs(x-c) - (body/2 - radius)
	qy := math.Abs(y-c) - (body/2 - radius)
	outside := math.Hypot(math.Max(qx, 0), math.Max(qy, 0))
	return outside + math.Min(math.Max(qx, qy), 0) - radius
}

// inShield 判断方块内归一化坐标 (u, v)（0..1，v 向下）是否落在盾牌里：上半是圆角矩形，下半收成尖角。
func inShield(u, v float64) bool {
	const t0, mid, b0, w0, r = 0.20, 0.50, 0.84, 0.30, 0.06
	if v < t0 || v > b0 {
		return false
	}
	dx := math.Abs(u - 0.5)
	if v <= mid {
		if dx > w0 {
			return false
		}
		if v < t0+r && dx > w0-r {
			return math.Hypot(dx-(w0-r), v-(t0+r)) <= r
		}
		return true
	}
	t := (v - mid) / (b0 - mid)
	return dx <= w0*math.Pow(math.Cos(t*math.Pi/2), 0.85)
}

func nearSegment(px, py, ax, ay, bx, by, w float64) bool {
	vx, vy := bx-ax, by-ay
	t := math.Max(0, math.Min(1, ((px-ax)*vx+(py-ay)*vy)/(vx*vx+vy*vy)))
	return math.Hypot(px-(ax+t*vx), py-(ay+t*vy)) <= w
}

func onCheck(u, v float64) bool {
	const w = 0.045
	return nearSegment(u, v, 0.36, 0.52, 0.46, 0.62, w) || nearSegment(u, v, 0.46, 0.62, 0.65, 0.41, w)
}

func main() {
	out := "."
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	img := image.NewNRGBA(image.Rect(0, 0, n, n))
	for y := range n {
		for x := range n {
			var r, g, b float64
			covered := 0
			for sy := range ss {
				for sx := range ss {
					px := float64(x) + (float64(sx)+0.5)/ss
					py := float64(y) + (float64(sy)+0.5)/ss
					if roundRectDist(px, py) > 0 {
						continue
					}
					covered++
					u, v := (px-inset)/body, (py-inset)/body
					if inShield(u, v) && !onCheck(u, v) {
						r, g, b = r+255, g+255, b+255
						continue
					}
					t := math.Max(0, math.Min(1, v))
					r += top[0] + (bottom[0]-top[0])*t
					g += top[1] + (bottom[1]-top[1])*t
					b += top[2] + (bottom[2]-top[2])*t
				}
			}
			a := float64(covered) / (ss * ss)
			// 方块下面垫一层柔和阴影
			d := roundRectDist(float64(x)+0.5, float64(y)+0.5-shOffY)
			sa := 0.0
			if d < shadow {
				k := 1 - math.Max(d, 0)/shadow
				sa = 0.30 * k * k
			}
			outA := a + sa*(1-a)
			if outA <= 0 {
				continue
			}
			if covered > 0 {
				r, g, b = r/float64(covered), g/float64(covered), b/float64(covered)
			}
			// 阴影是黑色：颜色按方块覆盖比例混合
			f := a / outA
			img.SetNRGBA(x, y, color.NRGBA{uint8(r*f + 0.5), uint8(g*f + 0.5), uint8(b*f + 0.5), uint8(outA*255 + 0.5)})
		}
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		log.Fatal(err)
	}
	f, err := os.Create(filepath.Join(out, "icon_1024.png"))
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		log.Fatal(err)
	}
}
