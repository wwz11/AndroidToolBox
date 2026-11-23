# Toolbox 应用图标

打包时使用的文件：`toolbox.ico`

## 默认图标

运行 `build.bat` 时会自动执行 `generate_toolbox_icon.py` 生成默认图标（蓝色工具箱样式，与 UI 主色一致）。

## 使用自己的图标

**推荐：** 将你的 `.ico`（建议含 16–256 多尺寸）复制为：

```
build/assets/toolbox.custom.ico
```

然后重新打包；构建脚本会优先使用该文件。

也可直接覆盖 `build/assets/toolbox.ico`（需为有效 Windows ICO 格式）。
