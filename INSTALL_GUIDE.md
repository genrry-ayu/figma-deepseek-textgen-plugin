# Figma 插件正确安装指南

## 🚀 正确的安装方法

### 方法一：通过 Figma 开发者模式安装（推荐）

1. **打开 Figma 开发者模式**
   - 在 Figma 中，点击右上角的用户头像
   - 选择「Settings」（设置）
   - 在左侧菜单中找到「Account」（账户）
   - 开启「Developer mode」（开发者模式）

2. **创建新插件**
   - 在 Figma 中，按 `Ctrl/Cmd + /` 打开插件菜单
   - 点击「Development」→「New plugin...」
   - 选择「Create a new plugin」
   - 选择「With UI and browser APIs」

3. **替换插件文件**
   - 在打开的插件编辑器中，删除默认的 `code.js` 和 `ui.html` 内容
   - 将我们项目中的 `code.js` 内容复制粘贴到 `code.js` 文件
   - 将我们项目中的 `ui.html` 内容复制粘贴到 `ui.html` 文件
   - 修改 `manifest.json` 文件，将内容替换为我们的配置

4. **保存并运行**
   - 点击「Save」保存插件
   - 在插件列表中就能看到「文案生成助手」
   - 点击运行即可使用

### 方法二：通过 Figma Desktop 安装

1. **下载 Figma Desktop**
   - 访问 [figma.com](https://www.figma.com/downloads/)
   - 下载并安装 Figma Desktop 应用

2. **创建插件文件夹**
   - 在本地创建一个文件夹，命名为 `textgen-plugin`
   - 将我们项目的所有文件复制到这个文件夹中

3. **在 Figma Desktop 中导入**
   - 打开 Figma Desktop
   - 按 `Ctrl/Cmd + /` 打开插件菜单
   - 点击「Development」→「Import plugin from manifest...」
   - 选择我们创建的 `manifest.json` 文件

## 📝 详细步骤说明

### 步骤 1：准备文件
确保您有以下文件：
```
textgen-plugin/
├── manifest.json
├── code.js
├── ui.html
└── README.md
```

### 步骤 2：修改 manifest.json
确保 `manifest.json` 内容正确：
```json
{
  "name": "文案生成助手",
  "id": "textgen-figma-plugin",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "capabilities": [],
  "enableProposedApi": false,
  "editorType": [
    "figma"
  ],
  "networkAccess": {
    "allowedDomains": [
      "https://api.openai.com",
      "https://api.anthropic.com"
    ]
  }
}
```

### 步骤 3：验证安装
1. 在 Figma 中打开插件菜单
2. 在「Development」分类下应该能看到「文案生成助手」
3. 点击插件名称启动插件
4. 如果看到插件界面，说明安装成功

## 🔧 常见问题解决

### 问题 1：插件不显示
**解决方案：**
- 确保 Figma 版本是最新的
- 检查 `manifest.json` 格式是否正确
- 重启 Figma 应用

### 问题 2：插件启动失败
**解决方案：**
- 检查 `code.js` 和 `ui.html` 文件是否完整
- 查看 Figma 开发者控制台是否有错误信息
- 确保所有文件都在同一目录下

### 问题 3：网络请求失败
**解决方案：**
- 确保网络连接正常
- 检查防火墙设置
- 验证 OpenAI API Key 是否有效

## 🎯 快速验证

安装完成后，可以通过以下步骤验证插件是否正常工作：

1. **启动插件**：在 Figma 中运行「文案生成助手」
2. **创建文本**：在画布中创建一个文本图层
3. **选择文本**：选中刚创建的文本图层
4. **配置 API Key**：在插件中输入您的 OpenAI API Key
5. **测试生成**：输入简单的文案需求，如"生成一个按钮文案"
6. **查看结果**：如果文本内容被更新，说明插件工作正常

## 📞 获取帮助

如果安装过程中遇到问题：
1. 检查 Figma 版本是否支持插件开发
2. 查看 Figma 开发者文档
3. 在项目 GitHub 页面提交 Issue

---

**按照这个指南，您就可以成功安装和使用文案生成助手插件了！** 🎉
