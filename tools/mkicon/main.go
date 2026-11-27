//go:build ignore

// mkicon 把应用图标原图 assets/icon.png（1024px 正方形、圆角外透明）缩成各平台要的图标。
// 用法：在仓库根目录 go run tools/mkicon/main.go <输出目录>，输出两份：
//   - icon_1024.png：macOS 原图（四周按 macOS 图标网格留白 10%，垫一层阴影），build_mac.sh 缩成 icns；
//   - app.ico：Windows 图标（原图铺满，内含 16～256px 各尺寸），build.sh 用 windres 编进 exe。
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const source = "assets/icon.png"

// downscale 用面积平均把正方形原图缩到 n×n（按 alpha 预乘，透明边缘不发黑）。
func downscale(src *image.NRGBA, n int) *image.NRGBA {
	size := src.Bounds().Dx()
	f := float64(size) / float64(n)
	dst := image.NewNRGBA(image.Rect(0, 0, n, n))
	for y := range n {
		y0, y1 := float64(y)*f, float64(y+1)*f
		for x := range n {
			x0, x1 := float64(x)*f, float64(x+1)*f
			var r, g, b, a float64
			for sy := int(y0); sy < int(math.Ceil(y1)) && sy < size; sy++ {
				wy := math.Min(y1, float64(sy+1)) - math.Max(y0, float64(sy))
				for sx := int(x0); sx < int(math.Ceil(x1)) && sx < size; sx++ {
					w := wy * (math.Min(x1, float64(sx+1)) - math.Max(x0, float64(sx)))
					p := src.NRGBAAt(sx, sy)
					pa := float64(p.A) * w
					r, g, b, a = r+float64(p.R)*pa, g+float64(p.G)*pa, b+float64(p.B)*pa, a+pa
				}
			}
			if a == 0 {
				continue
			}
			dst.SetNRGBA(x, y, color.NRGBA{uint8(r/a + 0.5), uint8(g/a + 0.5), uint8(b/a + 0.5), uint8(a/(f*f) + 0.5)})
		}
	}
	return dst
}

// boxBlur 对 n×n 的值做一次半径 r 的水平 + 垂直盒式模糊，连做三次近似高斯。
func boxBlur(v []float64, n, r int) {
	tmp := make([]float64, len(v))
	for range 3 {
		for pass := range 2 {
			for i := range n {
				for j := range n {
					var s float64
					for k := j - r; k <= j+r; k++ {
						if k < 0 || k >= n {
							continue
						}
						if pass == 0 {
							s += v[i*n+k]
						} else {
							s += v[k*n+i]
						}
					}
					if pass == 0 {
						tmp[i*n+j] = s / float64(2*r+1)
					} else {
						tmp[j*n+i] = s / float64(2*r+1)
					}
				}
			}
			copy(v, tmp)
		}
	}
}

// macIcon 把原图缩到 80% 放在 1024 画布中央，下面垫一层略向下偏的柔和阴影。
func macIcon(src *image.NRGBA) *image.NRGBA {
	const n, inset, offY, blur = 1024, 102, 12, 12
	body := downscale(src, n-2*inset)
	sh := make([]float64, n*n)
	for y := range n - 2*inset {
		for x := range n - 2*inset {
			if yy := y + inset + offY; yy < n {
				sh[yy*n+x+inset] = float64(body.NRGBAAt(x, y).A) / 255
			}
		}
	}
	boxBlur(sh, n, blur)
	dst := image.NewNRGBA(image.Rect(0, 0, n, n))
	for i, s := range sh {
		dst.Pix[i*4+3] = uint8(0.30*s*255 + 0.5)
	}
	draw.Draw(dst, body.Bounds().Add(image.Pt(inset, inset)), body, image.Point{}, draw.Over)
	return dst
}

// writeICO 把各尺寸图标以 PNG 形式打成一个 .ico（Windows Vista 起支持 PNG 条目）。
func writeICO(path string, src *image.NRGBA, sizes []int) error {
	var images [][]byte
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, downscale(src, s)); err != nil {
			return err
		}
		images = append(images, buf.Bytes())
	}
	var out bytes.Buffer
	le := binary.LittleEndian
	out.Write(le.AppendUint16(nil, 0))                  // 保留
	out.Write(le.AppendUint16(nil, 1))                  // 类型：图标
	out.Write(le.AppendUint16(nil, uint16(len(sizes)))) // 条目数
	offset := 6 + 16*len(sizes)
	for i, s := range sizes {
		dim := byte(s) // 256 记作 0
		out.Write([]byte{dim, dim, 0, 0})
		out.Write(le.AppendUint16(nil, 1))  // 色彩平面
		out.Write(le.AppendUint16(nil, 32)) // 每像素位数
		out.Write(le.AppendUint32(nil, uint32(len(images[i]))))
		out.Write(le.AppendUint32(nil, uint32(offset)))
		offset += len(images[i])
	}
	for _, img := range images {
		out.Write(img)
	}
	return os.WriteFile(path, out.Bytes(), 0o644)
}

func main() {
	out := "."
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	f, err := os.Open(source)
	if err != nil {
		log.Fatal(err)
	}
	decoded, err := png.Decode(f)
	f.Close()
	if err != nil {
		log.Fatal(err)
	}
	if b := decoded.Bounds(); b.Dx() != b.Dy() {
		log.Fatalf("%s 必须是正方形，现在是 %dx%d", source, b.Dx(), b.Dy())
	}
	src := image.NewNRGBA(decoded.Bounds())
	draw.Draw(src, src.Bounds(), decoded, decoded.Bounds().Min, draw.Src)

	if err := os.MkdirAll(out, 0o755); err != nil {
		log.Fatal(err)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, macIcon(src)); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "icon_1024.png"), buf.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
	if err := writeICO(filepath.Join(out, "app.ico"), src, []int{16, 20, 24, 32, 40, 48, 64, 128, 256}); err != nil {
		log.Fatal(err)
	}
}
