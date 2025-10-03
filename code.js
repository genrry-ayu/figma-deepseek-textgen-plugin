// Figma 文案生成插件主逻辑
// 作者：AI Assistant
// 版本：1.0.0

// 显示插件 UI
figma.showUI(__html__, { 
  width: 320, 
  height: 500,
  themeColors: true 
});

// 存储选中的文本节点
let selectedTextNodes = [];
// 记录容器的“用户选择顺序”，用于稳定排序下拉
let selectionOrder = [];

// 同步取消标志
let isSyncCancelled = false;
// 翻译取消标志
let isTranslateCancelled = false;

// 发送进度更新
function updateProgress(percentage, text, details) {
  figma.ui.postMessage({
    type: 'sync-progress',
    percentage: percentage,
    text: text,
    details: details
  });
}

// 监听来自 UI 的消息
figma.ui.onmessage = async (msg) => {
  try {
    console.log('收到消息:', msg.type, msg);
    
    switch (msg.type) {
      case 'get-selection':
        handleSelectionChange();
        break;
      case 'list-fonts':
        await listAvailableFonts();
        break;
      case 'list-text-styles':
        await listTextStyles();
        break;
      case 'replace-fonts':
        isReplaceCancelled = false;
        await replaceFontsInContainers(msg.fontFamily, msg.fontStyle, msg.containerIds);
        break;
      case 'replace-with-text-style':
        isReplaceCancelled = false;
        await replaceWithTextStyle(msg.styleId, msg.fontFamily, msg.fontStyle, msg.containerIds);
        break;
      case 'replace-font-family':
        isReplaceCancelled = false;
        await replaceFontFamilyInContainers(msg.fontFamily, msg.containerIds);
        break;
      case 'cancel-replace':
        isReplaceCancelled = true;
        figma.ui.postMessage({ type: 'replace-cancelled' });
        break;
      case 'generate-text':
        await generateText(msg.prompt, msg.apiKey, msg.nodeIds);
        break;
      case 'save-api-key':
        await saveApiKey(msg.apiKey);
        break;
      case 'load-api-key':
        await loadApiKey();
        break;
      case 'sync-frames':
        isSyncCancelled = false;
        console.log('收到同步请求，开始处理...');
        console.log('消息内容:', msg);
        
        try {
          // 立即发送进度更新，确保UI响应
          updateProgress(1, '收到同步请求...');
          
          // 设置超时机制，防止卡住
          const timeoutPromise = new Promise(function(_, reject) {
            setTimeout(function() {
              reject(new Error('同步超时，请重试'));
            }, 120000); // 超时提高到 120 秒，适配大型页面
          });
          
          // 检查是否使用高性能位置键算法
          console.log('使用按顺序同步算法');
          const syncPromise = syncFrames(msg.frameIds, msg.sourceFrameId, msg.threshold, msg.includeSourceFrame, msg.options);
          await Promise.race([syncPromise, timeoutPromise]);
        } catch (error) {
          console.error('同步过程中发生错误:', error);
          figma.ui.postMessage({
            type: 'sync-error',
            error: error.message
          });
        }
        break;
      case 'cancel-sync':
        isSyncCancelled = true;
        figma.ui.postMessage({ type: 'sync-cancelled' });
        break;
      case 'translate-texts':
        isTranslateCancelled = false;
        await translateSelection(msg.targetLang || 'English', msg.apiKey);
        break;
      case 'cancel-translate':
        isTranslateCancelled = true;
        figma.ui.postMessage({ type: 'translate-cancelled' });
        break;
      case 'ocr-sync':
        await handleOCRSync(msg.imageData, msg.frameIds, msg.options);
        break;
      case 'ocr-result':
        // 处理OCR识别结果
        if (window.ocrTimeout) {
          clearTimeout(window.ocrTimeout);
          window.ocrTimeout = null;
        }
        
        if (msg.success && window.ocrResolve) {
          window.ocrResolve(msg.text);
          window.ocrResolve = null;
          window.ocrReject = null;
        } else if (window.ocrReject) {
          window.ocrReject(new Error(msg.error || 'OCR识别失败'));
          window.ocrResolve = null;
          window.ocrReject = null;
        }
        break;
    }
  } catch (error) {
    console.error('插件错误:', error);
    figma.ui.postMessage({ 
      type: 'generate-error', 
      error: error.message 
    });
  }
};

// 判断节点是否可作为同步容器
function isSyncContainer(node) {
  if (!node) return false;
  const t = node.type;
  return t === 'FRAME' || t === 'GROUP' || t === 'COMPONENT' || t === 'INSTANCE' || t === 'SECTION';
}

// 处理选择变化（dynamic-page 需使用异步 API）
async function handleSelectionChange() {
  const selection = figma.currentPage.selection;
  selectedTextNodes = selection.filter(node => node.type === 'TEXT');
  // 将选择范围扩展到“任意对象”：
  // - 直接选中的容器 (FRAME/GROUP/COMPONENT/INSTANCE/SECTION) 作为候选
  // - 其它任意对象，映射到其最近的父容器，去重
  const frameSet = new Set();
  const containerIdsInThisSelection = [];
  for (let i = 0; i < selection.length; i++) {
    const node = selection[i];
    try {
      if (isSyncContainer(node)) { frameSet.add(node.id); }
      else { const pf = getParentFrame(node); if (pf) frameSet.add(pf.id); }
    } catch (_) {}
  }
  // 记录本次选择遍历顺序（作为 Set 插入顺序的备份）
  for (const id of frameSet) if (containerIdsInThisSelection.indexOf(id) === -1) containerIdsInThisSelection.push(id);

  // 读取节点 + 位置（左上角）供框选排序
  const idsAll = Array.from(frameSet);
  const nodeInfos = [];
  for (let i = 0; i < idsAll.length; i++) {
    try {
      const n = await figma.getNodeByIdAsync(idsAll[i]);
      if (!n || !isSyncContainer(n)) continue;
      let x = 0, y = 0;
      try { const p = apply(n.absoluteTransform, 0, 0); x = p.x; y = p.y; } catch (_) { try { x = n.x || 0; y = n.y || 0; } catch (_) {} }
      nodeInfos.push({ id: idsAll[i], node: n, x, y });
    } catch (_) {}
  }

  const presentSet = new Set(nodeInfos.map(function(it){ return it.id; }));
  const keep = [];
  for (let i = 0; i < selectionOrder.length; i++) {
    const id = selectionOrder[i];
    if (presentSet.has(id)) keep.push(id);
  }
  let missing = nodeInfos.filter(function(it){ return selectionOrder.indexOf(it.id) === -1; });
  // 若一次加入多个（常见于框选），按阅读顺序排序；单个则保留点击顺序
  if (missing.length > 1) missing.sort(function(a,b){ return (a.y - b.y) || (a.x - b.x); });
  const orderedIds = keep.concat(missing.map(function(it){ return it.id; }));
  selectionOrder = orderedIds;

  // 按最终顺序输出容器
  const byId = new Map(nodeInfos.map(function(it){ return [it.id, it.node]; }));
  const selectedFrames = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const n = byId.get(orderedIds[i]);
    if (n) selectedFrames.push(n);
  }
  
  // 发送选择信息到 UI
  figma.ui.postMessage({ 
    type: 'selection-changed', 
    nodes: selectedTextNodes.map(function(node) {
      return {
        id: node.id,
        name: node.name,
        characters: node.characters
      };
    }),
    frames: selectedFrames.map(function(frame) {
      return {
        id: frame.id,
        name: frame.name,
        width: frame.width,
        height: frame.height
      };
    }),
    anySelectionCount: selection.length
  });
}

// 监听选择变化事件
figma.on('selectionchange', function() {
  try { const p = handleSelectionChange(); if (p && typeof p.catch === 'function') p.catch(e => console.error('selectionchange error:', e)); }
  catch (e) { console.error('selectionchange sync error:', e); }
});

// 生成文案的主要函数
async function generateText(prompt, apiKey, nodeIds) {
  try {
    // 验证输入
    if (!prompt || !apiKey || !nodeIds || nodeIds.length === 0) {
      throw new Error('缺少必要参数');
    }

    // 获取要更新的文本节点
    const textNodesAll = await Promise.all(
      (nodeIds || []).map(function(id){ return figma.getNodeByIdAsync(id); })
    );
    const textNodes = textNodesAll.filter(function(node){ return node && node.type === 'TEXT'; });

    if (textNodes.length === 0) {
      throw new Error('未找到有效的文本节点');
    }

    // 批量生成所有文案
    await generateTextBatch(textNodes, prompt, apiKey);

    // 发送成功消息
    figma.ui.postMessage({ type: 'generate-success' });

  } catch (error) {
    console.error('生成文案失败:', error);
    figma.ui.postMessage({ 
      type: 'generate-error', 
      error: error.message 
    });
  }
}

// 批量生成所有文案
async function generateTextBatch(textNodes, prompt, apiKey) {
  try {
    // 加载字体（如果需要）
    await loadFontsIfNeeded(textNodes);

    // 一次性生成所有文案
    const generatedTexts = await callLLMAPI(prompt, apiKey, textNodes.length);
    
    if (!generatedTexts || generatedTexts.length === 0) {
      throw new Error('批量文案生成失败');
    }

    // 将生成的文案分配到对应的节点
    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      const text = generatedTexts[i] || generatedTexts[0]; // 如果文案不够，使用第一个
      
      if (node.type === 'TEXT') {
        node.characters = text;
      }
    }

  } catch (error) {
    throw new Error(`批量生成文案失败: ${error.message}`);
  }
}

// 智能优化用户提示词
function enhancePrompt(prompt, currentIndex, totalCount) {
  let enhancedPrompt = prompt;
  let referenceFormat = null;
  
  // 解析参考格式
  const referenceMatch = prompt.match(/参考[：:]\s*([^\s]+)/);
  if (referenceMatch) {
    referenceFormat = referenceMatch[1];
    // 从原提示词中移除参考格式部分
    enhancedPrompt = prompt.replace(/参考[：:]\s*[^\s]+/, '').trim();
  }
  
  // 如果有参考格式，优先使用参考格式
  if (referenceFormat) {
    // 解析参考格式中的变量（如 P0\P1 中的 P0 和 P1）
    const formatVariables = referenceFormat.match(/[A-Za-z]\d+/g) || [];
    const formatTemplate = referenceFormat.replace(/[A-Za-z]\d+/g, (match) => {
      const letter = match.charAt(0);
      const number = parseInt(match.slice(1));
      return `${letter}${number + currentIndex - 1}`;
    });
    
    enhancedPrompt = `生成内容，严格按照以下格式：${formatTemplate}。${enhancedPrompt}。请确保输出格式完全匹配：${formatTemplate}`;
    return enhancedPrompt;
  }
  
  // CRM/表格字段优化
  if (/公司地址|地址/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个真实的中国公司地址，格式为：省市区(县)+道路门牌号，例如 广东省深圳市南山区高新南七道12号。每行一个，不要引号和多余说明。`;
  }
  else if (/城市/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个中国城市名，仅输出城市名本身，如 北京、上海、杭州、成都。`;
  }
  else if (/(联系人|姓名|销售人员)/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个中文姓名，2-3 个汉字，不带称谓或标点。`;
  }
  else if (/(手机|手机号|电话)/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个中国大陆 11 位手机号，1[3-9] 开头，只输出数字，例如 13812345678。`;
  }
  else if (/(邮箱|电子邮件)/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个常见格式的公司邮箱，例如 li.wei@company.com，不包含说明或空格。`;
  }
  else if (/(客户规模|规模)/.test(prompt)) {
    enhancedPrompt = `从以下集合中选择，生成 ${totalCount} 个不同的客户规模：<20、20-100、100-500、500-1000、1000-10000、>10000。`;
  }
  else if (/(跟进状态|状态)/.test(prompt)) {
    enhancedPrompt = `从以下集合中选择，生成 ${totalCount} 个不同的跟进状态：已成交、跟进中、待联系、待决策、方案阶段。`;
  }
  else if (/(创建时间|日期|时间)/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个日期，格式为 YYYY/MM/DD，时间范围为近三年内，彼此不同。`;
  }
  else if (/(公司名称|公司名|企业名称|客户名称)/.test(prompt)) {
    enhancedPrompt = `生成 ${totalCount} 个真实感强的中文公司名称，包含常见后缀（如 有限公司/股份有限公司/科技有限公司），彼此不同，避免堆砌与重复。`;
  }

  // 快递单号优化
  if (prompt.includes('快递单号') || prompt.includes('运单号') || prompt.includes('物流单号')) {
    enhancedPrompt = `生成一个真实的快递单号，格式为：公司代码（2-3位大写字母）+ 9-12位数字。例如：SF123456789、YT987654321、JD456789123。请生成第${currentIndex}个不同的快递单号。`;
  }
  
  // 公司名称优化
  else if (prompt.includes('公司名称') || prompt.includes('公司名') || prompt.includes('企业名称')) {
    const industries = ['科技', '智能', '创新', '绿色', '智慧', '数字', '未来', '云端', '数据', '人工智能'];
    const suffixes = ['有限公司', '股份有限公司', '科技有限公司', '服务有限公司', '科技股份有限公司'];
    const randomIndustry = industries[Math.floor(Math.random() * industries.length)];
    const randomSuffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    enhancedPrompt = `生成一个独特且有创意的公司名称，包含"${randomIndustry}"相关词汇，以"${randomSuffix}"结尾。避免与常见公司名称重复，要有创新性和独特性。这是第${currentIndex}个公司名称。`;
  }
  
  // 产品名称优化
  else if (prompt.includes('产品名称') || prompt.includes('产品名') || prompt.includes('商品名称')) {
    enhancedPrompt = `生成一个简洁有力的产品名称，突出产品特色和功能，适合商业使用。这是第${currentIndex}个产品名称。`;
  }
  
  // 按钮文案优化
  else if (prompt.includes('按钮') || prompt.includes('按钮文案')) {
    const buttonStyles = ['简洁有力', '吸引眼球', '行动导向', '紧迫感', '友好亲切'];
    const randomStyle = buttonStyles[Math.floor(Math.random() * buttonStyles.length)];
    enhancedPrompt = `生成一个${randomStyle}的按钮文案，2-6个字，适合电商或应用界面使用。这是第${currentIndex}个按钮文案。`;
  }
  
  // 标题文案优化
  else if (prompt.includes('标题') || prompt.includes('标题文案')) {
    enhancedPrompt = `生成一个吸引人的标题文案，突出核心价值，适合网页或广告使用。这是第${currentIndex}个标题文案。`;
  }
  
  // 通用优化
  else {
    enhancedPrompt = `${prompt}。请确保内容独特且有创意，这是第${currentIndex}个文案。`;
  }
  
  return enhancedPrompt;
}

// 批量生成提示词优化
function enhancePromptForBatch(prompt, totalCount) {
  let enhancedPrompt = prompt;
  let referenceFormat = null;
  
  // 解析参考格式
  const referenceMatch = prompt.match(/参考[：:]\s*([^\s]+)/);
  if (referenceMatch) {
    referenceFormat = referenceMatch[1];
    // 从原提示词中移除参考格式部分
    enhancedPrompt = prompt.replace(/参考[：:]\s*[^\s]+/, '').trim();
    
    // 构建批量参考格式
    const formatVariables = referenceFormat.match(/[A-Za-z]\d+/g) || [];
    let batchFormat = '';
    for (let i = 0; i < totalCount; i++) {
      const formatTemplate = referenceFormat.replace(/[A-Za-z]\d+/g, (match) => {
        const letter = match.charAt(0);
        const number = parseInt(match.slice(1));
        return `${letter}${number + i}`;
      });
      batchFormat += formatTemplate + (i < totalCount - 1 ? '\n' : '');
    }
    
    enhancedPrompt = `生成 ${totalCount} 个内容，严格按照以下格式：
${batchFormat}

${enhancedPrompt}。请确保每个输出都完全匹配对应的格式。`;
    return enhancedPrompt;
  }
  
  // 快递单号优化
  if (prompt.includes('快递单号') || prompt.includes('运单号') || prompt.includes('物流单号')) {
    enhancedPrompt = `生成 ${totalCount} 个不同的快递单号，格式为：公司代码（2-3位大写字母）+ 9-12位数字。每个单号都要不同，避免重复。`;
  }
  
  // 公司名称优化
  else if (prompt.includes('公司名称') || prompt.includes('公司名') || prompt.includes('企业名称')) {
    enhancedPrompt = `生成 ${totalCount} 个独特且有创意的公司名称，每个都要不同，避免重复。名称要符合中文命名习惯，包含行业特征词。`;
  }
  
  // 产品名称优化
  else if (prompt.includes('产品名称') || prompt.includes('产品名') || prompt.includes('商品名称')) {
    enhancedPrompt = `生成 ${totalCount} 个不同的产品名称，每个都要简洁有力，突出产品特色和功能，适合商业使用。`;
  }
  
  // 按钮文案优化
  else if (prompt.includes('按钮') || prompt.includes('按钮文案')) {
    enhancedPrompt = `生成 ${totalCount} 个不同的按钮文案，每个2-6个字，适合电商或应用界面使用。每个文案都要有不同的风格和特点。`;
  }
  
  // 标题文案优化
  else if (prompt.includes('标题') || prompt.includes('标题文案')) {
    enhancedPrompt = `生成 ${totalCount} 个不同的标题文案，每个都要吸引人，突出核心价值，适合网页或广告使用。`;
  }
  
  // 通用优化
  else {
    enhancedPrompt = `生成 ${totalCount} 个不同的内容：${prompt}。请确保每个内容都独特且有创意，避免重复。`;
  }
  
  return enhancedPrompt;
}

// 解析批量生成的文案
function parseBatchText(generatedText, totalCount) {
  try {
    // 按换行符分割文案
    const lines = generatedText.split('\n').map(function(line) {
      return line.trim();
    }).filter(function(line) {
      return line.length > 0;
    });
    
    // 如果分割后的行数不够，尝试其他分割方式
    if (lines.length < totalCount) {
      // 尝试按其他分隔符分割
      const alternativeSplits = generatedText.split(/[，,；;]/).map(function(line) {
        return line.trim();
      }).filter(function(line) {
        return line.length > 0;
      });
      if (alternativeSplits.length >= totalCount) {
        return alternativeSplits.slice(0, totalCount);
      }
    }
    
    // 如果还是不够，重复使用现有的文案
    const result = [];
    for (let i = 0; i < totalCount; i++) {
      if (i < lines.length) {
        result.push(lines[i]);
      } else {
        // 重复使用第一个文案，并添加序号
        result.push(`${lines[0]}${i + 1}`);
      }
    }
    
    return result;
  } catch (error) {
    console.warn('解析批量文案失败:', error);
    // 如果解析失败，返回单个文案的数组
    return Array(totalCount).fill(generatedText);
  }
}

// 验证生成的内容是否符合指定格式
function validateFormat(generatedText, referenceFormat, currentIndex) {
  try {
    // 解析参考格式中的变量模式
    const formatVariables = referenceFormat.match(/[A-Za-z]\d+/g) || [];
    
    // 构建期望的格式模板
    const expectedFormat = referenceFormat.replace(/[A-Za-z]\d+/g, (match) => {
      const letter = match.charAt(0);
      const number = parseInt(match.slice(1));
      return `${letter}${number + currentIndex - 1}`;
    });
    
    // 检查生成的内容是否匹配期望格式
    // 支持精确匹配和包含匹配
    const isExactMatch = generatedText === expectedFormat;
    const containsFormat = generatedText.includes(expectedFormat);
    
    // 如果生成的内容包含期望格式，提取匹配部分
    if (containsFormat && !isExactMatch) {
      const formatRegex = new RegExp(expectedFormat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const match = generatedText.match(formatRegex);
      if (match) {
        return true; // 找到了匹配的格式
      }
    }
    
    return isExactMatch || containsFormat;
  } catch (error) {
    console.warn('格式验证出错:', error);
    return true; // 验证出错时允许通过
  }
}

// 调用 LLM API（批量生成模式）
async function callLLMAPI(prompt, apiKey, totalCount = 1) {
  try {
    // 构建请求数据
    const requestData = {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `你是一个专业的界面文案生成助手，面向中文产品（电商、CRM、后台表格/看板等）。请严格遵循：

【核心要求】
1. 必须生成 ${totalCount} 行结果，彼此不同
2. 只输出最终内容，不要任何前缀/编号/解释
3. 文案需简洁，默认 2–12 个汉字或等宽字符
4. 无需引号、括号或多余标点（除非用户明确要求）
5. 输出格式：每行一个结果，用换行分隔

【批量生成规则】
- 第1个：${totalCount >= 1 ? '生成第1个' : ''}
- 第2个：${totalCount >= 2 ? '与第1个明显不同' : ''}
- 第3个：${totalCount >= 3 ? '与前两个明显不同' : ''}
- 第4个：${totalCount >= 4 ? '与前三个明显不同' : ''}
- 第5个：${totalCount >= 5 ? '与前四个明显不同' : ''}

【CRM/后台字段（当提示词命中以下关键词时，严格使用对应规范）】
- 公司名称/企业名称/客户名称：仿真实中文公司名，含常见后缀（有限公司/股份有限公司/科技有限公司等），避免堆砌与重复
- 公司地址/地址：省市区(县)+道路门牌号，如 广东省深圳市南山区高新南七道12号
- 城市：仅输出城市名，如 北京、上海、杭州、成都，尽量 2–3 字
- 联系人/姓名/销售人员：中文姓名 2–3 字，如 王磊、陈雅涵，不带称谓
- 手机/电话/手机号：11 位中国大陆手机号，1[3-9] 开头，如 13812345678
- 邮箱/电子邮件：合理邮箱，如 li.wei@company.com
- 客户规模/规模：从集合中选择 <20、20-100、100-500、500-1000、1000-10000、>10000
- 跟进状态/状态：从集合中选择 已成交、跟进中、待联系、待决策、方案阶段
- 创建时间/日期：YYYY/MM/DD，近三年内随机日期

【其他常见示例】
- 快递单号：SF123456789、YT987654321、JD456789123
- 产品名称：智能手环、无线充电器、高清摄像头
- 按钮文案：立即购买、马上抢购、加入购物车

【参考格式支持】
- 当用户提供参考格式（如"参考：P0\\P1"），必须严格按该格式输出
- 格式中的序号自动递增（P0→P1→P2...）
- 结果必须完全匹配格式模板

【输出要求】
- 数量准确、彼此差异明显
- 仅输出结果本身，逐行一个`
        },
        {
          role: "user",
          content: enhancePromptForBatch(prompt, totalCount)
        }
      ],
      max_tokens: Math.max(50, totalCount * 20),
      temperature: 0.9
    };

    // 发送请求到 DeepSeek API
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestData)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API 请求失败: ${response.status} ${(errorData.error && errorData.error.message) || response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('API 返回格式错误');
    }

    const generatedText = data.choices[0].message.content.trim();
    
    // 解析批量生成的文案
    const generatedTexts = parseBatchText(generatedText, totalCount);
    
    // 验证格式（如果有参考格式）
    const referenceMatch = prompt.match(/参考[：:]\s*([^\s]+)/);
    if (referenceMatch) {
      const referenceFormat = referenceMatch[1];
      const validatedTexts = [];
      
      for (let i = 0; i < generatedTexts.length; i++) {
        const text = generatedTexts[i];
        const isValidFormat = validateFormat(text, referenceFormat, i + 1);
        if (!isValidFormat) {
          console.warn(`格式验证失败，文案${i + 1}：${text}`);
          // 如果格式不符合，使用期望格式
          const expectedFormat = referenceFormat.replace(/[A-Za-z]\d+/g, (match) => {
            const letter = match.charAt(0);
            const number = parseInt(match.slice(1));
            return `${letter}${number + i}`;
          });
          validatedTexts.push(expectedFormat);
        } else {
          validatedTexts.push(text);
        }
      }
      
      return validatedTexts;
    }
    
    return generatedTexts;

  } catch (error) {
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('网络连接失败，请检查网络设置');
    }
    throw error;
  }
}


// 高性能字体收集 - 全局去重，避免重复加载
async function collectFontsForNodes(textNodes) {
  const fontSet = new Map();
  
  for (const node of textNodes) {
    if (node.characters.length === 0) {
      // 空文本节点，使用默认字体
      if (node.fontName !== figma.mixed) {
        const fontName = node.fontName;
        const key = `${fontName.family}__${fontName.style}`;
        fontSet.set(key, fontName);
      }
      continue;
    }
    
    // 尝试使用新API获取字体信息
    try {
      const segments = node.getStyledTextSegments(['fontName']);
      if (segments && segments.length > 0) {
        for (const segment of segments) {
          const key = `${segment.fontName.family}__${segment.fontName.style}`;
          fontSet.set(key, segment.fontName);
        }
      } else {
        // 回退到旧API，但只抽样检查
        const len = node.characters.length;
        const sampleIndices = [0, Math.floor(len / 2), len - 1].filter(i => i >= 0);
        
        for (const i of sampleIndices) {
          const fontName = node.getRangeFontName(i, i + 1);
          const key = `${fontName.family}__${fontName.style}`;
          fontSet.set(key, fontName);
        }
      }
    } catch (error) {
      console.warn('字体收集失败:', node.name, error);
    }
  }
  
  return fontSet;
}

// 批量加载字体
async function loadFontsBatch(fontMap) {
  const fontPromises = Array.from(fontMap.values()).map(function(fontName) {
    return figma.loadFontAsync(fontName).catch(function(error) {
      console.warn(`字体加载失败: ${fontName.family} ${fontName.style}`, error);
    });
  });
  
  await Promise.all(fontPromises);
}

// 兼容性函数 - 保持向后兼容
async function loadFontsIfNeeded(textNodes) {
  const fontMap = await collectFontsForNodes(textNodes);
  await loadFontsBatch(fontMap);
}

// 插件关闭时的清理工作
figma.on('close', () => {
  // 清理资源
  selectedTextNodes = [];
});

// 保存 API Key 到本地存储
async function saveApiKey(apiKey) {
  try {
    const apiSettings = {
      apiKey: apiKey,
      timestamp: Date.now()
    };
    
    await figma.clientStorage.setAsync('deepseekApiSettings', apiSettings);
    figma.ui.postMessage({ 
      type: 'api-key-saved',
      success: true 
    });
    
    console.log('API Key 已保存到本地存储');
  } catch (error) {
    console.error('保存 API Key 失败:', error);
    figma.ui.postMessage({ 
      type: 'api-key-saved',
      success: false,
      error: error.message 
    });
  }
}

// 从本地存储加载 API Key
async function loadApiKey() {
  try {
    const storedSettings = await figma.clientStorage.getAsync('deepseekApiSettings');
    
    if (storedSettings && storedSettings.apiKey) {
      figma.ui.postMessage({ 
        type: 'api-key-loaded',
        apiKey: storedSettings.apiKey,
        success: true 
      });
      
      console.log('API Key 已从本地存储加载');
    } else {
      figma.ui.postMessage({ 
        type: 'api-key-loaded',
        success: false 
      });
      
      console.log('未找到存储的 API Key');
    }
  } catch (error) {
    console.error('加载 API Key 失败:', error);
    figma.ui.postMessage({ 
      type: 'api-key-loaded',
      success: false,
      error: error.message 
    });
  }
}

// ========== 高性能位置键同步算法 ==========

// 基础工具函数
const sleep = function(ms) {
  if (ms === undefined) ms = 0;
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
};

const dist = function(a, b) {
  return Math.hypot(a.nx - b.nx, a.ny - b.ny);
};

// 矩阵变换工具
function apply(m, x, y) {
  const a = m[0][0], c = m[0][1], e = m[0][2];
  const b = m[1][0], d = m[1][1], f = m[1][2];
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

// 可见性（包含父级）判断
function isNodeVisibleDeep(node) {
  let cur = node;
  while (cur) {
    try { if (cur.visible === false) return false; } catch (_) {}
    cur = cur.parent;
  }
  return true;
}

// ========== 字体列表与替换 ==========

// 列出当前账号可用字体
async function listAvailableFonts() {
  try {
    const fonts = await figma.listAvailableFontsAsync();
    const payload = fonts.map(function(f) {
      return { family: f.fontName.family, style: f.fontName.style };
    });
    figma.ui.postMessage({ type: 'fonts-listed', fonts: payload });
  } catch (error) {
    console.error('列出字体失败:', error);
    figma.ui.postMessage({ type: 'replace-error', error: '读取字体失败：' + error.message });
  }
}

// 在选中的 Frame / Section 中替换文本节点字体
let isReplaceCancelled = false;

async function replaceFontsInContainers(fontFamily, fontStyle, containerIds) {
  try {
    if (!fontFamily || !fontStyle) throw new Error('未选择字体');

    const targetFont = { family: fontFamily, style: fontStyle };
    try { await figma.loadFontAsync(targetFont); } catch (_) {}

    // 收集容器（允许任意被选节点作为根）
    const containers = [];
    if (Array.isArray(containerIds) && containerIds.length) {
      for (let i = 0; i < containerIds.length; i++) {
        const node = await figma.getNodeByIdAsync(containerIds[i]);
        if (node) containers.push(node);
      }
    } else {
      // 兜底：用当前选择（不限类型）
      const sel = figma.currentPage.selection;
      for (let i = 0; i < sel.length; i++) {
        containers.push(sel[i]);
      }
    }

    if (containers.length === 0) throw new Error('请先选择至少 1 个对象');

    // 收集文本节点（仅可见：扫描所有后代 TEXT）
    const textNodes = [];
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      try {
        const nodes = c.findAllWithCriteria({ types: ['TEXT'] });
        for (let j = 0; j < nodes.length; j++) {
          const n = nodes[j];
          if (isNodeVisibleDeep(n)) textNodes.push(n);
        }
      } catch (_) {
        const rec = getTextNodesInFrameRecursive(c);
        for (let j = 0; j < rec.length; j++) if (isNodeVisibleDeep(rec[j])) textNodes.push(rec[j]);
      }
    }

    if (textNodes.length === 0) {
      figma.ui.postMessage({ type: 'replace-summary', count: 0 });
      return;
    }

    const total = textNodes.length; let done = 0;
    const batchSize = 200;
    for (let i = 0; i < textNodes.length; i += batchSize) {
      if (isReplaceCancelled) break;
      const slice = textNodes.slice(i, i + batchSize);
      for (let j = 0; j < slice.length; j++) {
        const n = slice[j];
        try {
          if (n.locked) continue;
          const len = n.characters.length || 0;
          if (len === 0) {
            // 空文本：若已是目标字体则跳过
            try { if (n.fontName !== figma.mixed) { const f = n.fontName; if (f.family === fontFamily && f.style === fontStyle) { done++; continue; } } } catch (_) {}
            n.fontName = targetFont;
          } else {
            n.setRangeFontName(0, len, targetFont);
          }
        } catch (_) {
          // 忽略单点失败
        } finally { done++; }
      }
      const pct = Math.floor((done / total) * 100);
      figma.ui.postMessage({ type: 'replace-progress', percentage: pct, text: '字体替换中...', details: pct + '%' });
      await sleep(0);
    }

    if (isReplaceCancelled) {
      figma.ui.postMessage({ type: 'replace-cancelled', count: done });
    } else {
      figma.ui.postMessage({ type: 'replace-summary', count: done });
    }
  } catch (error) {
    console.error('字体替换失败:', error);
    figma.ui.postMessage({ type: 'replace-error', error: error.message });
  }
}

// 仅替换字体家族（保留各段落字重/样式），无法匹配的样式回退到 Regular/第一个可用样式
async function replaceFontFamilyInContainers(fontFamily, containerIds) {
  try {
    if (!fontFamily) throw new Error('未选择字体');

    // 统计该 family 可用样式
    const all = await figma.listAvailableFontsAsync();
    const styles = all.filter(function(f){ return f.fontName.family === fontFamily; }).map(function(f){ return f.fontName.style; });
    const available = new Set(styles);
    if (available.size === 0) throw new Error('该字体不可用');

    const pickFallback = function() {
      if (available.has('Regular')) return 'Regular';
      return styles[0];
    };

    const loaded = new Set();
    async function ensureLoaded(style) {
      const key = fontFamily + '||' + style;
      if (loaded.has(key)) return style;
      try {
        await figma.loadFontAsync({ family: fontFamily, style: style });
        loaded.add(key);
        return style;
      } catch (_) {
        const fb = pickFallback();
        const fbKey = fontFamily + '||' + fb;
        if (!loaded.has(fbKey)) {
          await figma.loadFontAsync({ family: fontFamily, style: fb });
          loaded.add(fbKey);
        }
        return fb;
      }
    }

    // 容器（允许任意被选节点作为根）
    const containers = [];
    if (Array.isArray(containerIds) && containerIds.length) {
      for (let i = 0; i < containerIds.length; i++) {
        const node = await figma.getNodeByIdAsync(containerIds[i]);
        if (node) containers.push(node);
      }
    } else {
      const sel = figma.currentPage.selection;
      for (let i = 0; i < sel.length; i++) containers.push(sel[i]);
    }

    if (containers.length === 0) throw new Error('请先选择至少 1 个对象');

    // 文本节点（仅可见：扫描所有后代 TEXT）
    const textNodes = [];
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      try {
        const nodes = c.findAllWithCriteria({ types: ['TEXT'] });
        for (let j = 0; j < nodes.length; j++) if (isNodeVisibleDeep(nodes[j])) textNodes.push(nodes[j]);
      } catch (e) {
        const rec = getTextNodesInFrameRecursive(c);
        for (let j = 0; j < rec.length; j++) if (isNodeVisibleDeep(rec[j])) textNodes.push(rec[j]);
      }
    }

    const total = textNodes.length; let done = 0;
    const batchSize = 120;
    for (let i = 0; i < textNodes.length; i += batchSize) {
      if (isReplaceCancelled) break;
      const slice = textNodes.slice(i, i + batchSize);
      for (let k = 0; k < slice.length; k++) {
        const n = slice[k];
        try {
          if (n.locked) continue;
          const len = n.characters.length || 0;
          // 空文本直接设置整体字体家族（保留风格尽量匹配）
          if (len === 0 && n.fontName !== figma.mixed) {
            const cur = n.fontName; const used = available.has(cur.style) ? cur.style : pickFallback();
            if (!(cur.family === fontFamily && cur.style === used)) {
              n.fontName = { family: fontFamily, style: used };
            }
          } else if (len > 0) {
            // 为了极致性能：整段设置成 family + 现有 style 或 fallback
            let styleName = 'Regular';
            try {
              if (n.getStyledTextSegments) {
                const segs = n.getStyledTextSegments(['fontName']);
                if (segs && segs.length) styleName = segs[0].fontName.style || 'Regular';
              } else if (n.fontName !== figma.mixed && n.fontName && n.fontName.style) {
                styleName = n.fontName.style;
              }
            } catch (_) {}
            if (!available.has(styleName)) styleName = pickFallback();
            // 确保所需样式已加载
            try { await figma.loadFontAsync({ family: fontFamily, style: styleName }); } catch (_) {}
            n.setRangeFontName(0, len, { family: fontFamily, style: styleName });
          }
        } catch (_) {
          // 忽略单点失败
        } finally { 
          done++; 
          if (done % 25 === 0) {
            const pctStep = Math.floor((done / total) * 100);
            figma.ui.postMessage({ type: 'replace-progress', percentage: pctStep, text: '字体替换中...', details: pctStep + '%' });
            await sleep(0);
          }
        }
      }
      const pct = Math.floor((done / total) * 100);
      figma.ui.postMessage({ type: 'replace-progress', percentage: pct, text: '字体替换中...', details: pct + '%' });
      await sleep(0);
    }

    if (isReplaceCancelled) {
      figma.ui.postMessage({ type: 'replace-cancelled', count: done });
    } else {
      figma.ui.postMessage({ type: 'replace-summary', count: done });
    }
  } catch (error) {
    console.error('仅替换字体家族失败:', error);
    figma.ui.postMessage({ type: 'replace-error', error: error.message });
  }
}
// 列出本文件中的本地文本样式（视为样式 token）
async function listTextStyles() {
  try {
    const styles = figma.getLocalTextStyles();
    const payload = styles.map(function(s) {
      return {
        id: s.id,
        name: s.name,
        fontFamily: s.fontName.family,
        fontStyle: s.fontName.style
      };
    });
    figma.ui.postMessage({ type: 'text-styles-listed', styles: payload });
  } catch (error) {
    console.error('读取文本样式失败:', error);
    figma.ui.postMessage({ type: 'replace-error', error: '读取文本样式失败：' + error.message });
  }
}

// 使用文本样式替换（应用为文本样式 token）
async function replaceWithTextStyle(styleId, fontFamily, fontStyle, containerIds) {
  try {
    if (!styleId) throw new Error('未选择文本样式');

    // 预加载样式所需字体（保险起见）
    if (fontFamily && fontStyle) {
      try { await figma.loadFontAsync({ family: fontFamily, style: fontStyle }); } catch (_) {}
    }

    // 容器收集（允许任意被选节点作为根）
    const containers = [];
    if (Array.isArray(containerIds) && containerIds.length) {
      for (let i = 0; i < containerIds.length; i++) {
        const node = await figma.getNodeByIdAsync(containerIds[i]);
        if (node) containers.push(node);
      }
    } else {
      const sel = figma.currentPage.selection;
      for (let i = 0; i < sel.length; i++) containers.push(sel[i]);
    }

    if (containers.length === 0) throw new Error('请先选择至少 1 个对象');

    // 收集文本节点（仅可见）
    const textNodes = [];
    for (let i = 0; i < containers.length; i++) {
      const c = containers[i];
      try {
        const nodes = c.findAllWithCriteria({ types: ['TEXT'] });
        for (let j = 0; j < nodes.length; j++) if (isNodeVisibleDeep(nodes[j])) textNodes.push(nodes[j]);
      } catch (e) {
        const rec = getTextNodesInFrameRecursive(c);
        for (let j = 0; j < rec.length; j++) if (isNodeVisibleDeep(rec[j])) textNodes.push(rec[j]);
      }
    }

    const total = textNodes.length;
    let done = 0;
    for (let i = 0; i < textNodes.length; i++) {
      if (isReplaceCancelled) break;
      const n = textNodes[i];
      try {
        if (n.locked) continue;
        const len = n.characters.length;
        if (len > 0) {
          n.setRangeTextStyleId(0, len, styleId);
        } else {
          // 空节点时尽量直接赋值样式 id
          try { n.textStyleId = styleId; } catch (_) {}
        }
      } catch (_) {
        // 忽略单点失败
      } finally {
        done++;
        const pct = Math.floor((done / total) * 100);
        figma.ui.postMessage({ type: 'replace-progress', percentage: pct, text: '样式替换中...', details: pct + '%' });
        await sleep(0);
      }
    }

    if (isReplaceCancelled) {
      figma.ui.postMessage({ type: 'replace-cancelled', count: done });
    } else {
      figma.ui.postMessage({ type: 'replace-summary', count: done });
    }
  } catch (error) {
    console.error('应用文本样式失败:', error);
    figma.ui.postMessage({ type: 'replace-error', error: error.message });
  }
}

function invert(m) {
  const a = m[0][0], c = m[0][1], e = m[0][2];
  const b = m[1][0], d = m[1][1], f = m[1][2];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) throw new Error('non-invertible');
  const ia = d / det, ic = -c / det, ib = -b / det, id = a / det;
  const ie = -(ia * e + ic * f), ifv = -(ib * e + id * f);
  return [[ia, ic, ie], [ib, id, ifv]];
}

function centerInFrame(frame, node) {
  try {
    const abs = node.absoluteTransform;
    const ctr = apply(abs, (node.width || 0) / 2, (node.height || 0) / 2);
    const inv = invert(frame.absoluteTransform);
    return apply(inv, ctr.x, ctr.y);
  } catch (e) {
    // 回退：使用局部坐标估算（在父容器坐标系下），避免不可逆矩阵导致崩溃
    try {
      return { x: (node.x || 0) + (node.width || 0) / 2, y: (node.y || 0) + (node.height || 0) / 2 };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }
}

// 通用锚点转换：'center' | 'topleft'
function anchorInFrame(frame, node, anchor) {
  const mode = (anchor || 'center').toLowerCase();
  if (mode === 'topleft') {
    try {
      const abs = node.absoluteTransform;
      const pt = apply(abs, 0, 0);
      const inv = invert(frame.absoluteTransform);
      return apply(inv, pt.x, pt.y);
    } catch (e) {
      try { return { x: (node.x || 0), y: (node.y || 0) }; } catch (_) { return { x: 0, y: 0 }; }
    }
  }
  return centerInFrame(frame, node);
}

function norm(frame, p) {
  const w = Math.max(1e-6, Number(frame.width) || 0);
  const h = Math.max(1e-6, Number(frame.height) || 0);
  return { nx: p.x / w, ny: p.y / h };
}

// ========== 翻译功能 ==========

// 获取节点绝对中心坐标
function getAbsoluteCenter(node) {
  try {
    const abs = node.absoluteTransform;
    const ctr = apply(abs, node.width / 2, node.height / 2);
    return { x: ctr.x, y: ctr.y };
  } catch (_) {
    return { x: node.x || 0, y: node.y || 0 };
  }
}

// 收集当前选择内的所有文本节点（任意容器）
function collectTextNodesFromSelection() {
  const result = [];
  const sel = figma.currentPage.selection || [];
  const seen = new Set();

  const isVisibleDeep = function(n) {
    let cur = n;
    while (cur) {
      try { if (cur.visible === false) return false; } catch (_) {}
      cur = cur.parent;
    }
    return true;
  };

  function pushIfOk(n) {
    if (!n) return;
    if (n.type === 'TEXT' && !seen.has(n.id) && isVisibleDeep(n)) {
      seen.add(n.id);
      result.push(n);
    }
  }

  function traverse(root) {
    if (!root) return;
    // 跳过不可见分支以提速
    try { if (root.visible === false) return; } catch (_) {}
    if (root.type === 'TEXT') {
      pushIfOk(root);
      return;
    }
    const children = root.children || [];
    for (let i = 0; i < children.length; i++) {
      traverse(children[i]);
    }
  }

  for (let i = 0; i < sel.length; i++) {
    try {
      traverse(sel[i]);
    } catch (e) {
      // 忽略单个节点失败
    }
  }

  return result;
}

// DeepSeek 翻译调用（批量）
async function callDeepSeekTranslateBatch(lines, targetLang, apiKey) {
  if (!lines || lines.length === 0) return [];
  const systemPrompt = `You are a professional UI/UX translator.
Translate the following lines into ${targetLang}.
Rules:
1) Keep line count and order exactly.
2) No numbering, no quotes, no explanations.
3) Preserve placeholders, variables, and URLs as-is (e.g. {name}, %s, https://...).
4) Keep emojis and special symbols.
Output: one translated line per input line, separated by \n.`;

  const userContent = lines.join('\n');
  const requestData = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.3,
    max_tokens: Math.min(4096, Math.max(200, lines.length * 40))
  };

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestData)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`API 请求失败: ${response.status} ${(errorData.error && errorData.error.message) || response.statusText}`);
  }

  const data = await response.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('API 返回格式错误');
  }
  const content = (data.choices[0].message.content || '').trim();
  const out = content.split('\n').map(function(s){ return s.replace(/^\s+|\s+$/g, ''); });
  if (out.length < lines.length) {
    const alt = content.split(/[，,；;]\s*/).map(function(s){ return s.replace(/^\s+|\s+$/g, ''); });
    while (out.length < lines.length && alt.length) out.push(alt.shift());
    while (out.length < lines.length) out.push(lines[out.length]);
  } else if (out.length > lines.length) {
    return out.slice(0, lines.length);
  }
  return out;
}

// 带标签的单次打包翻译与解析
function buildTaggedLines(lines, offset) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const tag = String(i + 1 + (offset || 0)).padStart(4, '0');
    out.push(`<<<#${tag}>>> ${lines[i]}`);
  }
  return out;
}

function parseTaggedResponse(content) {
  const map = new Map();
  const regex = /<<<#(\d{4})>>>\s*([\s\S]*?)(?=(?:\n<<<#\d{4}>>>|$))/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    const id = m[1];
    const text = (m[2] || '').replace(/^[\s\t]+|[\s\t]+$/g, '');
    map.set(id, text);
  }
  return map;
}

async function callDeepSeekTranslateTaggedSingle(lines, targetLang, apiKey) {
  const systemPrompt = `You are a professional UI/UX translator. Translate user interface strings into ${targetLang}.\nStrict rules:\n- Keep the special marker <<<#NNNN>>> at line start unchanged. Do not translate or alter markers.\n- Return exactly the same number of lines, same order.\n- Each output line must start with the same marker then a space, then ONLY the translated text.\n- No extra commentary, numbering, or quotes.\n- Preserve placeholders/variables/URLs as-is (e.g. {name}, %s, https://...).\n- Keep emojis and special symbols.`;

  const tagged = buildTaggedLines(lines, 0);
  const userContent = tagged.join('\n');
  const requestData = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.2,
    max_tokens: Math.min(16000, Math.max(200, lines.length * 50))
  };

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(requestData)
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`API 请求失败: ${response.status} ${(errorData.error && errorData.error.message) || response.statusText}`);
  }
  const data = await response.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('API 返回格式错误');
  }
  const content = (data.choices[0].message.content || '').trim();
  const map = parseTaggedResponse(content);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const key = String(i + 1).padStart(4, '0');
    out.push(map.get(key) !== undefined ? map.get(key) : lines[i]);
  }
  return out;
}

// ========== Token 预算估算与分批辅助 ==========
function estimateTokensFromText(s) {
  if (!s) return 0;
  // 为避免超限，使用偏大的估算：1 字符 ≈ 1.2 token
  return Math.ceil(s.length * 1.2);
}

function estimateTaggedInputTokens(lines) {
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const tag = `<<<#${String(i + 1).padStart(4, '0')}>>> `;
    total += estimateTokensFromText(tag) + estimateTokensFromText(lines[i]);
  }
  return total;
}

function estimateTaggedOutputTokens(lines) {
  // 近似认为输出与输入等长（含标记）
  return estimateTaggedInputTokens(lines);
}

function buildBatchesByTokenBudget(lines, totalBudgetTokens) {
  // 按输入/输出 6:4 的比例切分预算
  const inputBudget = Math.floor(totalBudgetTokens * 0.6);
  const outputBudget = totalBudgetTokens - inputBudget;
  const batches = [];
  let cur = [];
  let inTok = 0;
  let outTok = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 估算当前项 token（带标记）
    const tag = `<<<#${String((cur.length || 0) + 1).padStart(4, '0')}>>> `;
    const add = estimateTokensFromText(tag) + estimateTokensFromText(l);
    if (cur.length > 0 && (inTok + add > inputBudget || outTok + add > outputBudget)) {
      batches.push(cur);
      cur = [l];
      inTok = estimateTokensFromText('<<<#0001>>> ') + estimateTokensFromText(l);
      outTok = inTok;
    } else {
      cur.push(l);
      inTok += add;
      outTok += add;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function callDeepSeekTranslateTaggedBatched(lines, targetLang, apiKey) {
  // 单请求 token 总预算（输入+输出），可按模型上下文调整
  const TOTAL_BUDGET_PER_REQ = 8000; // 保守
  const batches = buildBatchesByTokenBudget(lines, TOTAL_BUDGET_PER_REQ);
  const out = new Array(lines.length);
  let processed = 0;
  const totalBatches = batches.length;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const offset = processed;
    // 进度：将分批翻译映射到 15% - 65% 区间
    try {
      const pct = 15 + Math.floor((bi / Math.max(1, totalBatches)) * 50);
      figma.ui.postMessage({ type: 'translate-progress', percentage: pct, text: `分批翻译中 ${processed}/${lines.length}...（${bi + 1}/${totalBatches}）` });
    } catch (_) {}
    const systemPrompt = `You are a professional UI/UX translator. Translate user interface strings into ${targetLang}.\nStrict rules:\n- Keep the special marker <<<#NNNN>>> at line start unchanged. Do not translate or alter markers.\n- Return exactly the same number of lines, same order.\n- Each output line must start with the same marker then a space, then ONLY the translated text.\n- No extra commentary.\n- Preserve placeholders/variables/URLs as-is.`;
    const tagged = buildTaggedLines(batch, offset);
    // 输出 max_tokens 也根据估算设置
    const estimatedOut = estimateTaggedOutputTokens(batch);
    const requestData = {
      model: 'deepseek-chat',
      messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: tagged.join('\n') } ],
      temperature: 0.2,
      max_tokens: Math.min(6000, Math.max(200, Math.ceil(estimatedOut * 1.2)))
    };
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(requestData)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API 请求失败: ${response.status} ${(errorData.error && errorData.error.message) || response.statusText}`);
    }
    const data = await response.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    const map = parseTaggedResponse(content);
    for (let i = 0; i < batch.length; i++) {
      const key = String(i + 1 + offset).padStart(4, '0');
      out[offset + i] = map.get(key) !== undefined ? map.get(key) : batch[i];
    }
    processed += batch.length;
    try {
      const pct = 15 + Math.floor((Math.min(bi + 1, totalBatches) / Math.max(1, totalBatches)) * 50);
      figma.ui.postMessage({ type: 'translate-progress', percentage: pct, text: `分批翻译中 ${processed}/${lines.length}...（${Math.min(bi + 1, totalBatches)}/${totalBatches}）` });
    } catch (_) {}
    await new Promise(function(r){ setTimeout(r, 0); });
  }
  return out;
}

// 并发分批翻译（最优策略）：按 token 预算切批 + 多批并行
async function callDeepSeekTranslateTaggedParallel(lines, targetLang, apiKey, concurrency) {
  const TOTAL_BUDGET_PER_REQ = 8000; // 与串行分批一致的预算
  const batches = buildBatchesByTokenBudget(lines, TOTAL_BUDGET_PER_REQ);
  const out = new Array(lines.length);
  const totalBatches = batches.length;
  if (totalBatches === 0) return out;

  // 计算每批的全局偏移，确保标签唯一
  const offsets = new Array(totalBatches);
  let acc = 0;
  for (let i = 0; i < totalBatches; i++) {
    offsets[i] = acc;
    acc += batches[i].length;
  }

  // 轻量 system prompt，减少 token 占用
  const buildRequest = function(batch, offset) {
    const sys = `Translate UI strings to ${targetLang}. Keep markers <<<#NNNN>>> unchanged; same line count and order. Each line: marker + space + translated text only. Preserve placeholders/URLs. No extra text.`;
    const tagged = buildTaggedLines(batch, offset);
    const estimatedOut = estimateTaggedOutputTokens(batch);
    const req = {
      model: 'deepseek-chat',
      messages: [ { role: 'system', content: sys }, { role: 'user', content: tagged.join('\n') } ],
      temperature: 0.2,
      max_tokens: Math.min(6000, Math.max(200, Math.ceil(estimatedOut * 1.2)))
    };
    return req;
  };

  let completed = 0;
  async function runOne(idx) {
    const batch = batches[idx];
    const offset = offsets[idx];
    // 进度：映射到 15% - 65%
    try {
      const pct = 15 + Math.floor((completed / Math.max(1, totalBatches)) * 50);
      figma.ui.postMessage({ type: 'translate-progress', percentage: pct, text: `并发翻译中…（${completed}/${totalBatches}）` });
    } catch (_) {}

    const requestData = buildRequest(batch, offset);
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(requestData)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API 请求失败: ${response.status} ${(errorData.error && errorData.error.message) || response.statusText}`);
    }
    const data = await response.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    const map = parseTaggedResponse(content);
    for (let i = 0; i < batch.length; i++) {
      const key = String(i + 1 + offset).padStart(4, '0');
      out[offset + i] = map.get(key) !== undefined ? map.get(key) : batch[i];
    }
    completed++;
    try {
      const pct = 15 + Math.floor((completed / Math.max(1, totalBatches)) * 50);
      figma.ui.postMessage({ type: 'translate-progress', percentage: pct, text: `并发翻译中…（${completed}/${totalBatches}）` });
    } catch (_) {}
  }

  // 简单 worker 池
  const pool = Math.max(1, Math.min(concurrency || 2, 6));
  let next = 0;
  const workers = new Array(pool).fill(0).map(async function() {
    while (next < totalBatches) {
      const idx = next++;
      if (isTranslateCancelled) throw new Error('用户取消');
      await runOne(idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// 将数组分批以控制请求体大小
function chunkBySize(items, maxItems, maxChars) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    if ((cur.length + 1 > maxItems) || (len + s.length > maxChars)) {
      if (cur.length) batches.push(cur);
      cur = [s];
      len = s.length;
    } else {
      cur.push(s);
      len += s.length;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// 翻译当前选择内文本
async function translateSelection(targetLang, apiKey) {
  try {
    if (!apiKey) throw new Error('缺少 API Key');

    figma.ui.postMessage({ type: 'translate-progress', percentage: 2, text: '收集文本节点...' });
    const nodes = collectTextNodesFromSelection();
    const writable = nodes.filter(function(n){ return canWriteToNode(n); });
    const nonEmpty = writable.filter(function(n){ return (n.characters || '').length > 0; });

    if (nonEmpty.length === 0) throw new Error('未找到可翻译的文本节点');

    // 严格阅读顺序：先按行（由上到下），再按列（行内从左到右）
    const centers = new Map();
    const ys = [];
    const hs = [];
    for (let i = 0; i < nonEmpty.length; i++) {
      const n = nonEmpty[i];
      const c = getAbsoluteCenter(n);
      centers.set(n.id, c);
      ys.push(c.y);
      try { hs.push(Math.max(1, n.height || 0)); } catch (_) {}
    }
    ys.sort(function(a,b){ return a-b; });
    hs.sort(function(a,b){ return a-b; });
    const medianH = hs.length ? hs[Math.floor(hs.length/2)] : 16;
    const tol = Math.max(4, Math.min(32, medianH * 0.6));

    // 先按 y 排序，再分行，行内按 x 升序
    nonEmpty.sort(function(a,b){ return centers.get(a.id).y - centers.get(b.id).y; });
    const rows = [];
    let current = [];
    let currentY = null;
    for (let i = 0; i < nonEmpty.length; i++) {
      const n = nonEmpty[i];
      const cy = centers.get(n.id).y;
      if (currentY === null || Math.abs(cy - currentY) <= tol) {
        current.push(n);
        // 动态更新行参考 y，取加权平均可减少抖动
        if (currentY === null) currentY = cy; else currentY = (currentY * (current.length - 1) + cy) / current.length;
      } else {
        // 结束上一行，行内按 x 排序
        current.sort(function(a,b){ return centers.get(a.id).x - centers.get(b.id).x; });
        rows.push(current);
        // 开始新行
        current = [n];
        currentY = cy;
      }
    }
    if (current.length) {
      current.sort(function(a,b){ return centers.get(a.id).x - centers.get(b.id).x; });
      rows.push(current);
    }
    // 按行展开为严格阅读顺序
    const ordered = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let j = 0; j < row.length; j++) ordered.push(row[j]);
    }
    // 使用新顺序替换 nonEmpty
    nonEmpty.splice(0, nonEmpty.length, ...ordered);

    const texts = nonEmpty.map(function(n){ return n.characters; });
    const total = texts.length;
    figma.ui.postMessage({ type: 'translate-progress', percentage: 5, text: `准备翻译 ${total} 条文本...` });

    await loadFontsIfNeeded(nonEmpty);

    // 性能优化：去重相同文案，仅翻译唯一项
    const uniqueList = [];
    const uniqueIndexByText = new Map();
    const bucketByUnique = new Map(); // uniqueIdx -> [originalIndices]
    const shouldTranslate = function(s) {
      if (!s) return false;
      const t = ('' + s).trim();
      if (t.length === 0) return false;
      // 仅数字/常见符号的直接跳过
      if (/^[0-9\s\-+.,:;\/()]+$/.test(t)) return false;
      return true;
    };

    const originalResults = new Array(total);
    for (let i = 0; i < texts.length; i++) {
      const raw = texts[i];
      if (!shouldTranslate(raw)) {
        originalResults[i] = raw;
        continue;
      }
      const key = raw.trim();
      let uidx = uniqueIndexByText.get(key);
      if (uidx === undefined) {
        uidx = uniqueList.length;
        uniqueIndexByText.set(key, uidx);
        uniqueList.push(key);
      }
      if (!bucketByUnique.has(uidx)) bucketByUnique.set(uidx, []);
      bucketByUnique.get(uidx).push(i);
    }

    // 若无需翻译（全部跳过），直接写回并结束
    if (uniqueList.length === 0) {
      let written = 0;
      const writeBatch = 200;
      for (let i = 0; i < nonEmpty.length; i += writeBatch) {
        const slice = nonEmpty.slice(i, i + writeBatch);
        for (let k = 0; k < slice.length; k++) {
          try { slice[k].characters = originalResults[i + k] || texts[i + k]; written++; } catch (_) {}
        }
        const pct = 70 + Math.floor(((i + writeBatch) / nonEmpty.length) * 30);
        figma.ui.postMessage({ type: 'translate-progress', percentage: Math.min(pct, 98), text: `写入中 ${Math.min(i + writeBatch, nonEmpty.length)}/${nonEmpty.length}...` });
        await new Promise(function(r){ setTimeout(r, 0); });
      }
      figma.ui.postMessage({ type: 'translate-progress', percentage: 100, text: '翻译完成' });
      figma.ui.postMessage({ type: 'translate-summary', total, written });
      return;
    }

    // 根据 token 预算决定是否一次性翻译，否则直接分批（仅对唯一项）
    let translatedUniques;
    const overhead = 800;
    const totalIn = estimateTaggedInputTokens(uniqueList);
    const totalOut = estimateTaggedOutputTokens(uniqueList);
    const totalTokens = totalIn + totalOut + overhead;
    const SINGLESHOT_LIMIT = 12000; // 可按模型上下文调大/调小
    if (totalTokens <= SINGLESHOT_LIMIT) {
      try {
        if (isTranslateCancelled) throw new Error('用户取消');
        figma.ui.postMessage({ type: 'translate-progress', percentage: 20, text: '一次性打包翻译中...' });
        translatedUniques = await callDeepSeekTranslateTaggedSingle(uniqueList, targetLang, apiKey);
      } catch (e) {
        if (isTranslateCancelled) throw e;
        figma.ui.postMessage({ type: 'translate-progress', percentage: 20, text: '单次失败，改为并发分批翻译...' });
        translatedUniques = await callDeepSeekTranslateTaggedParallel(uniqueList, targetLang, apiKey, 3);
      }
    } else {
      figma.ui.postMessage({ type: 'translate-progress', percentage: 15, text: '文本较多，自动并发分批翻译...' });
      translatedUniques = await callDeepSeekTranslateTaggedParallel(uniqueList, targetLang, apiKey, 3);
    }

    // 如果标记翻译几乎未变（模型忽略了翻译要求），回退到旧的简单一shot或分批（对唯一项）
    try {
      let unchanged = 0;
      for (let i = 0; i < translatedUniques.length; i++) {
        if ((translatedUniques[i] || '').trim() === (uniqueList[i] || '').trim()) unchanged++;
      }
      const ratio = translatedUniques.length ? unchanged / translatedUniques.length : 1;
      if (ratio >= 0.9) {
        // 先尝试旧的一次性批量
        figma.ui.postMessage({ type: 'translate-progress', percentage: 25, text: '回退：尝试一次性批量翻译...' });
        try {
          const oneShot = await callDeepSeekTranslateBatch(uniqueList, targetLang, apiKey);
          translatedUniques = oneShot;
        } catch (e2) {
          // 再尝试旧的分批
          figma.ui.postMessage({ type: 'translate-progress', percentage: 25, text: '回退：并发分批翻译中...' });
          translatedUniques = await callDeepSeekTranslateTaggedParallel(uniqueList, targetLang, apiKey, 3);
        }
      }
    } catch (_) {
      // 忽略回退统计失败
    }

    // 将唯一项翻译结果映射回原顺序
    const results = new Array(total);
    for (let [uidx, idxList] of bucketByUnique.entries()) {
      const val = translatedUniques[uidx];
      for (let p = 0; p < idxList.length; p++) results[idxList[p]] = val;
    }
    for (let i = 0; i < results.length; i++) if (results[i] === undefined) results[i] = originalResults[i] || texts[i];

    // 写回
    let written = 0;
    const writeBatch = 300; // 提高单批写入，减少批次数
    for (let i = 0; i < nonEmpty.length; i += writeBatch) {
      if (isTranslateCancelled) throw new Error('用户取消');
      const slice = nonEmpty.slice(i, i + writeBatch);
      for (let k = 0; k < slice.length; k++) {
        try {
          slice[k].characters = results[i + k] || texts[i + k];
          written++;
        } catch (_) {}
      }
      const pct = 70 + Math.floor(((i + writeBatch) / nonEmpty.length) * 30);
      figma.ui.postMessage({ type: 'translate-progress', percentage: Math.min(pct, 98), text: `写入中 ${Math.min(i + writeBatch, nonEmpty.length)}/${nonEmpty.length}...` });
      await new Promise(function(r){ setTimeout(r, 0); });
    }

    figma.ui.postMessage({ type: 'translate-progress', percentage: 100, text: '翻译完成' });
    figma.ui.postMessage({ type: 'translate-summary', total, written });
  } catch (error) {
    if ((error && ('' + error.message).includes('取消')) || isTranslateCancelled) {
      figma.ui.postMessage({ type: 'translate-cancelled' });
      return;
    }
    console.error('翻译失败:', error);
    figma.ui.postMessage({ type: 'translate-error', error: error.message });
  }
}

// 收集文本节点（优化版本）
function collectTexts(frame) {
  try {
    // 先尝试使用递归方式，随后做“深度可见性”过滤
    const nodes = getTextNodesInFrameRecursive(frame) || [];
    return nodes.filter(function(n){
      try { return isNodeVisibleDeep(n); } catch (_) { return n.visible !== false; }
    });
  } catch (error) {
    console.warn('递归方式失败，尝试findAllWithCriteria:', error);
    try {
      const nodes = frame.findAllWithCriteria({ types: ['TEXT'] }) || [];
      return nodes.filter(function(n){
        try { return isNodeVisibleDeep(n); } catch (_) { return n.visible !== false; }
      });
    } catch (error2) {
      console.error('所有方式都失败:', error2);
      return [];
    }
  }
}

// 位置键索引类型
function kPos(ix, iy, isx, isy) {
  if (isx === undefined) {
    return ix + ',' + iy;
  } else {
    return ix + ',' + iy + ',' + isx + ',' + isy;
  }
}

// 建立位置键索引
function indexFrameByPos(frame, opts) {
  if (opts === undefined) opts = {};
  const cell = opts.cell !== undefined ? opts.cell : 0.02;   // 2% 网格
  const useSize = !!opts.useSize;
  const cellSize = opts.cellSize !== undefined ? opts.cellSize : 0.04; // 尺寸格
  const anchor = (opts.anchor || 'center');
  
  // 使用高性能文本节点收集（仅可见文本）
  const texts = getTextNodesInFrame(frame);
  const infos = [];
  
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const p = norm(frame, anchorInFrame(frame, t, anchor));
    let size;
    if (useSize) {
      size = { nw: t.width / frame.width, nh: t.height / frame.height };
    }
    infos.push({
      node: t,
      pos: p,
      size: size,
      nameKey: (t.name || '').trim()
    });
  }
  
  const byName = new Map();
  const byBin = new Map();
  
  const push = function(map, key, v) {
    const arr = map.get(key);
    if (arr) {
      arr.push(v);
    } else {
      map.set(key, [v]);
    }
  };
  
  for (let i = 0; i < infos.length; i++) {
    const it = infos[i];
    if (it.nameKey) {
      if (!byName.has(it.nameKey)) byName.set(it.nameKey, []);
      byName.get(it.nameKey).push(it);
    }
    
    const ix = Math.floor(it.pos.nx / cell);
    const iy = Math.floor(it.pos.ny / cell);
    let key;
    
    if (useSize && it.size) {
      const isx = Math.floor(it.size.nw / cellSize);
      const isy = Math.floor(it.size.nh / cellSize);
      key = kPos(ix, iy, isx, isy);
    } else {
      key = kPos(ix, iy);
    }
    
    push(byBin, key, it);
  }
  
  return {
    infos: infos,
    index: {
      byName: byName,
      byBin: byBin,
      used: new Set(),
      cell: cell,
      cellSize: useSize ? cellSize : undefined
    }
  };
}

// 位置键查询
function lookupByPosKey(pivot, idx, tol) {
  if (tol === undefined) tol = 0.06;
  
  const ix = Math.floor(pivot.pos.nx / idx.cell);
  const iy = Math.floor(pivot.pos.ny / idx.cell);
  const grids = [];
  
  if (idx.cellSize && pivot.size) {
    const isx = Math.floor(pivot.size.nw / idx.cellSize);
    const isy = Math.floor(pivot.size.nh / idx.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = kPos(ix + dx, iy + dy, isx, isy);
        grids.push(key);
      }
    }
  } else {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        grids.push(kPos(ix + dx, iy + dy));
      }
    }
  }
  
  let best = null;
  let bestD = Infinity;
  
  for (let i = 0; i < grids.length; i++) {
    const key = grids[i];
    const bucket = idx.byBin.get(key);
    if (!bucket) continue;
    
    for (let j = 0; j < bucket.length; j++) {
      const cand = bucket[j];
      if (idx.used.has(cand.node.id)) continue;
      
      const d = dist(pivot.pos, cand.pos);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
  }
  
  return (best && bestD <= tol) ? best : null;
}

// 字体收集与加载
function fKey(f) {
  return f.family + '__' + f.style;
}

async function collectFonts(nodes) {
  const fonts = new Map();
  
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.characters.length === 0) {
      if (n.fontName !== figma.mixed) {
        const f = n.fontName;
        fonts.set(fKey(f), f);
      }
      continue;
    }
    
    const segs = n.getStyledTextSegments && n.getStyledTextSegments(['fontName']);
    if (segs && segs.length) {
      for (let j = 0; j < segs.length; j++) {
        fonts.set(fKey(segs[j].fontName), segs[j].fontName);
      }
    } else {
      const L = n.characters.length;
      const pick = new Set([0, Math.floor(L / 2), L - 1].filter(function(i) {
        return i >= 0;
      }));
      
      const pickArray = Array.from(pick);
      for (let k = 0; k < pickArray.length; k++) {
        const idx = pickArray[k];
        const f = n.getRangeFontName(idx, idx + 1);
        fonts.set(fKey(f), f);
      }
    }
  }
  
  return fonts;
}

async function loadFontSet(fonts) {
  const fontArray = Array.from(fonts.values());
  const promises = fontArray.map(function(f) {
    return figma.loadFontAsync(f);
  });
  await Promise.all(promises);
}

// 统一内容规则
function chooseUnified(pivot, cands) {
  const pv = (pivot.characters || '').trim();
  if (pv) return pivot.characters;
  
  for (let i = 0; i < cands.length; i++) {
    const n = cands[i];
    const v = (n.characters || '').trim();
    if (v) return n.characters;
  }
  
  return '';
}

// 简化的位置键同步主函数
async function syncByPositionKey(frameIds, sourceFrameId, threshold, includeSourceFrame, options) {
  try {
    console.log('开始简化位置键同步，参数:', { frameIds, sourceFrameId, threshold, includeSourceFrame });
    
    // 立即更新进度，确保UI响应
    updateProgress(5, '开始同步...');
    
    // 解析/合并参数（允许 UI 传入 options 覆盖）
    const opt = options || {};
    const cell = (typeof opt.cell === 'number' && opt.cell > 0) ? opt.cell : 0.02;               // 网格尺寸（归一化）
    const tol = (typeof opt.tol === 'number' && opt.tol > 0) ? opt.tol : (threshold || 0.10);    // 匹配容差
    const useSize = opt.useSize !== undefined ? !!opt.useSize : true;                             // 是否叠加尺寸维度
    const nameFirst = opt.nameFirst !== undefined ? !!opt.nameFirst : true;                       // 是否同名优先
    const nameOnly = opt.nameOnly !== undefined ? !!opt.nameOnly : false;                         // 仅按同名
    const posOnly = opt.posOnly !== undefined ? !!opt.posOnly : false;                            // 仅按位置
    const batch = (typeof opt.batchSize === 'number' && opt.batchSize > 0) ? opt.batchSize : 100; // 写入批大小
    const dryRun = !!opt.dryRun;                                                                   // 预览模式

    if (!frameIds || frameIds.length < 2) {
      throw new Error('至少需要选择2个Frame');
    }

    if (!sourceFrameId) {
      throw new Error('请选择源Frame');
    }

    updateProgress(10, '获取Frame节点...');
    console.log('开始获取Frame节点，frameIds:', frameIds);
    
    // 添加延迟，确保UI更新
    await new Promise(function(resolve) {
      setTimeout(resolve, 100);
    });
    
    // 立即更新进度，确保UI响应
    updateProgress(15, '正在处理...');
    
    // 获取所有Frame节点
    const frames = [];
    for (let i = 0; i < frameIds.length; i++) {
      const id = frameIds[i];
      console.log(`获取节点 ${i + 1}/${frameIds.length}: ${id}`);
      
      try {
        const node = await figma.getNodeByIdAsync(id);
        console.log(`节点 ${id} 获取结果:`, node ? node.type : 'null');
        
        if (node && isSyncContainer(node)) {
          frames.push(node);
          console.log(`成功添加容器: ${node.name}`);
        } else {
          console.warn(`节点 ${id} 不是可同步容器或不存在`);
        }
      } catch (error) {
        console.error(`获取节点 ${id} 时出错:`, error);
      }
      
      // 每处理一个节点就更新进度
      const progress = 15 + Math.floor((i + 1) / frameIds.length * 10);
      updateProgress(progress, `获取Frame节点... ${i + 1}/${frameIds.length}`);
    }
    
    console.log(`总共获取到 ${frames.length} 个有效Frame节点`);

    if (frames.length < 2) {
      throw new Error('未找到有效的Frame节点');
    }

    // 获取源Frame
    let sourceFrame = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].id === sourceFrameId) {
        sourceFrame = frames[i];
        break;
      }
    }
    
    if (!sourceFrame) {
      throw new Error('未找到源Frame');
    }

    console.log(`开始位置键同步: ${frames.length} 个Frame, 源Frame: ${sourceFrame.name}`);
    
    updateProgress(25, '构建文本索引...');
    
    // 添加延迟，确保UI更新
    await new Promise(function(resolve) {
      setTimeout(resolve, 100);
    });
    
    // 构建源Frame索引
    updateProgress(30, '构建源Frame索引...');
    
    let pivotIndex;
    try {
      pivotIndex = indexFrameByPos(sourceFrame, { cell: cell, useSize: useSize, anchor: opt.anchor });
      if (pivotIndex.infos.length === 0) {
        figma.notify('源Frame中没有文本节点');
        return;
      }
      
      console.log(`源Frame "${sourceFrame.name}" 包含 ${pivotIndex.infos.length} 个文本节点`);
      
      // 添加延迟，确保UI更新
      await new Promise(function(resolve) {
        setTimeout(resolve, 100);
      });
      
      updateProgress(40, '构建目标Frame索引...');
      
    } catch (error) {
      console.error('构建源Frame索引失败:', error);
      throw new Error('构建源Frame索引失败: ' + error.message);
    }

    // 构建目标Frame索引
    const targetFrames = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (includeSourceFrame || frame.id !== sourceFrameId) {
        targetFrames.push(frame);
      }
    }
    
    const targets = [];
    for (let i = 0; i < targetFrames.length; i++) {
      const frame = targetFrames[i];
      console.log(`构建目标Frame索引: ${frame.name}`);
      
      try {
        const targetIndex = indexFrameByPos(frame, { cell: cell, useSize: useSize, anchor: opt.anchor });
        targets.push({
          frame: frame,
          infos: targetIndex.infos,
          index: targetIndex.index
        });
        console.log(`目标Frame "${frame.name}" 包含 ${targetIndex.infos.length} 个文本节点`);
        
        // 每处理一个目标Frame就更新进度
        const progress = 40 + Math.floor((i + 1) / targetFrames.length * 20);
        updateProgress(progress, `构建目标Frame索引... ${i + 1}/${targetFrames.length}`);
        
      } catch (error) {
        console.error(`构建目标Frame "${frame.name}" 索引失败:`, error);
        // 继续处理其他Frame
      }
    }
    
    updateProgress(60, '开始匹配...');
    
    // 添加延迟，确保UI更新
    await new Promise(function(resolve) {
      setTimeout(resolve, 100);
    });

    // 提示尺寸差异
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const r = Math.min(t.frame.width / sourceFrame.width, t.frame.height / sourceFrame.height);
      if (r < 0.8 || r > 1.25) {
        figma.notify('提示：部分帧与源帧尺寸差异较大，匹配可能不准');
        break;
      }
    }

    let pairs = 0;
    let writes = 0;
    let miss = 0;
    const pending = [];

    // 匹配阶段
    for (let i = 0; i < pivotIndex.infos.length; i++) {
      if (isSyncCancelled) {
        figma.ui.postMessage({ type: 'sync-cancelled' });
        return;
      }
      
      const pi = pivotIndex.infos[i];
      const matched = [];
      
      // 减少进度更新频率，每10个节点更新一次
      if (i % 10 === 0 || i === pivotIndex.infos.length - 1) {
        const matchProgress = 60 + Math.floor((i / pivotIndex.infos.length) * 20);
        updateProgress(matchProgress, `匹配进度 ${i + 1}/${pivotIndex.infos.length}`);
      }

      for (let j = 0; j < targets.length; j++) {
        const t = targets[j];
        let best = null;

        // 同名优先匹配
        if (!posOnly && nameFirst && pi.nameKey && t.index.byName.has(pi.nameKey)) {
          const arr = t.index.byName.get(pi.nameKey).filter(function(x) {
            return !t.index.used.has(x.node.id);
          });
          if (arr.length) {
            let bestD = Infinity;
            for (let k = 0; k < arr.length; k++) {
              const cand = arr[k];
              const d = dist(pi.pos, cand.pos);
              if (d < bestD) {
                bestD = d;
                best = cand;
              }
            }
            if (best && bestD > tol) best = null;
          }
        }

        // 位置键匹配
        if (!best && !nameOnly) {
          best = lookupByPosKey(pi, t.index, tol);
        }

        if (best) {
          t.index.used.add(best.node.id);
          matched.push(best.node);
          pairs++;
        } else {
          miss++;
        }
      }

      if (matched.length === 0) continue;
      
      const unified = chooseUnified(pi.node, matched);
      for (let k = 0; k < matched.length; k++) {
        const n = matched[k];
        if (n.characters !== unified) {
          pending.push({ node: n, text: unified });
        }
      }
    }

    if (dryRun) {
      // 干跑模式：仅汇总统计，不写入
      const msg = `预览完成：匹配 ${pairs} 处，将写入 ${pending.length}，未匹配 ${miss}`;
      figma.notify(msg);
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: pairs,
        replaceCount: pending.length,
        unmatchCount: miss,
        skippedCount: 0,
        lockedCount: 0,
        componentCount: 0,
        dryRun: true
      });
      return;
    }

    if (pending.length === 0) {
      figma.notify('同步完成：匹配 ' + pairs + '，无需改动');
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: pairs,
        replaceCount: 0,
        unmatchCount: miss,
        skippedCount: 0,
        lockedCount: 0,
        componentCount: 0
      });
      return;
    }

    updateProgress(80, '加载字体...');
    
    // 一次性加载字体
    const fontSet = await collectFonts(pending.map(function(p) {
      return p.node;
    }));
    await loadFontSet(fontSet);

    updateProgress(90, '写入文本...');
    
  // 分批写入
  for (let i = 0; i < pending.length; i += batch) {
      if (isSyncCancelled) {
        figma.ui.postMessage({ type: 'sync-cancelled' });
        return;
      }
      
      const chunk = pending.slice(i, i + batch);
      for (let j = 0; j < chunk.length; j++) {
        const w = chunk[j];
        try {
          w.node.characters = w.text;
          writes++;
        } catch (e) {
          // 若为组件实例中的文本（绑定到组件属性），尝试改用实例属性覆盖
          try {
            const ok = await trySetTextViaInstanceProperty(w.node, w.text);
            if (ok) {
              writes++;
            } else {
              console.warn('写入失败（实例属性匹配不到）:', w.node.name, e);
            }
          } catch (e2) {
            console.warn('写入失败（实例属性覆盖异常）:', w.node.name, e2);
          }
        }
      }
      
      // 更新写入进度
      const writeProgress = 90 + Math.floor((i + batch) / pending.length * 10);
      updateProgress(Math.min(writeProgress, 99), `写入进度 ${Math.min(i + batch, pending.length)}/${pending.length}`);
      
      await sleep(0);
    }

    updateProgress(100, '同步完成');
    
    const message = '同步完成：匹配 ' + pairs + '，写入 ' + writes + '，未匹配 ' + miss;
    figma.notify(message);
    console.log(message);

    figma.ui.postMessage({
      type: 'sync-summary',
      matchCount: pairs,
      replaceCount: writes,
      unmatchCount: miss,
      skippedCount: 0,
      lockedCount: 0,
      componentCount: 0
    });

  } catch (error) {
    console.error('位置键同步失败:', error);
    figma.ui.postMessage({
      type: 'sync-error',
      error: error.message
    });
  }
}

// 按顺序同步功能（优化版本）
async function syncFrames(frameIds, sourceFrameId, threshold = 0.12, includeSourceFrame = false, options = {}) {
  try {
    console.log('开始顺序同步函数，参数:', { frameIds, sourceFrameId, threshold, includeSourceFrame, options });
    
    const {
      batchSize = 100,         // 分批写入大小
      dryRun = false           // 干跑模式（仅预览，不写入）
    } = options;

    if (frameIds.length < 2) {
      throw new Error('至少需要选择2个Frame');
    }

    if (!sourceFrameId) {
      throw new Error('请选择源Frame');
    }

    console.log('开始获取Frame节点...');
    updateProgress(5, '获取Frame节点...');
    
    // 获取所有Frame节点
    const frames = [];
    for (let i = 0; i < frameIds.length; i++) {
      const id = frameIds[i];
      const node = await figma.getNodeByIdAsync(id);
      console.log(`获取节点 ${id}:`, node ? node.type : 'null');
      if (node && isSyncContainer(node)) {
        frames.push(node);
      }
    }

    console.log(`找到 ${frames.length} 个有效Frame节点`);

    if (frames.length < 2) {
      throw new Error('未找到有效的Frame节点');
    }

    // 获取源Frame
    let sourceFrame = null;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].id === sourceFrameId) {
        sourceFrame = frames[i];
        break;
      }
    }
    
    if (!sourceFrame) {
      throw new Error('未找到源Frame');
    }

    console.log(`开始简化多帧同步: ${frames.length} 个Frame, 源Frame: ${sourceFrame.name}`);
    
    // 更新进度
    updateProgress(10, '开始同步...');

    // 检查是否已取消
    if (isSyncCancelled) {
      figma.ui.postMessage({ type: 'sync-cancelled' });
      return;
    }
    
    // 按顺序提取源Frame的文本
    updateProgress(20, '按顺序提取文本...');
    console.log('开始按顺序提取源Frame文本...');
    
    let sourceTexts;
    try {
      sourceTexts = extractTextsInOrder(sourceFrame);
      console.log(`源Frame "${sourceFrame.name}" 按顺序提取到 ${sourceTexts.length} 个文本:`, sourceTexts);
    } catch (error) {
      console.error('按顺序提取文本失败:', error);
      throw new Error(`按顺序提取文本失败: ${error.message}`);
    }
    
    if (sourceTexts.length === 0) {
      figma.notify('源Frame中没有文本节点');
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: 0,
        replaceCount: 0,
        unmatchCount: 0,
        skippedCount: 0,
        lockedCount: 0,
        componentCount: 0
      });
      return;
    }

    // 获取目标Frame
    updateProgress(30, '获取目标Frame...');
    console.log('开始获取目标Frame...');
    
    const targetFrames = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (includeSourceFrame || frame.id !== sourceFrameId) {
        targetFrames.push(frame);
      }
    }
    
    console.log(`找到 ${targetFrames.length} 个目标Frame`);
    
    // 检查是否已取消
    if (isSyncCancelled) {
      figma.ui.postMessage({ type: 'sync-cancelled' });
      return;
    }

    // 按顺序同步到目标Frame
    updateProgress(40, '按顺序同步到目标Frame...');
    let totalWrites = 0;
    let totalSkipped = 0;

    for (let i = 0; i < targetFrames.length; i++) {
      // 检查是否已取消
      if (isSyncCancelled) {
        figma.ui.postMessage({ type: 'sync-cancelled' });
        return;
      }
      
      const targetFrame = targetFrames[i];
      console.log(`同步到Frame: ${targetFrame.name}`);
      
      try {
        const writes = await replaceTextsInOrder(targetFrame, sourceTexts);
        totalWrites += writes;
        console.log(`Frame ${targetFrame.name} 同步完成，写入 ${writes} 个文本`);
      } catch (error) {
        console.warn(`同步Frame ${targetFrame.name} 时出错:`, error);
        totalSkipped++;
      }

      // 更新进度
      const progress = 40 + Math.floor((i / targetFrames.length) * 50);
      updateProgress(progress, `同步进度 ${i + 1}/${targetFrames.length}`);
    }

    if (dryRun) {
      // 干跑模式：只显示统计信息
      const message = `预览完成：将同步 ${sourceTexts.length} 个文本到 ${targetFrames.length} 个Frame`;
      figma.notify(message);
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: sourceTexts.length,
        replaceCount: sourceTexts.length * targetFrames.length,
        unmatchCount: 0,
        skippedCount: totalSkipped,
        lockedCount: 0,
        componentCount: 0,
        dryRun: true
      });
      return;
    }

    // 发送同步结果
    updateProgress(100, '同步完成！');
    const message = `同步完成：写入 ${totalWrites} 个文本，跳过 ${totalSkipped} 个Frame`;
    
    figma.notify(message);
    console.log(`顺序同步完成: ${message}`);

    figma.ui.postMessage({
      type: 'sync-summary',
      matchCount: sourceTexts.length,
      replaceCount: totalWrites,
      unmatchCount: 0,
      skippedCount: totalSkipped,
      lockedCount: 0,
      componentCount: 0
    });

  } catch (error) {
    console.error('高性能多帧同步失败:', error);
    figma.ui.postMessage({
      type: 'sync-error',
      error: error.message 
    });
  }
}

// 按顺序提取文本（从左到右，从上到下）
function extractTextsInOrder(frame) {
  try {
    // 获取所有文本节点
    const textNodes = frame.findAllWithCriteria({ types: ['TEXT'] });
    
    // 过滤可见节点
    const visibleNodes = textNodes.filter(function(n){
      try { return isNodeVisibleDeep(n); } catch (_) { return n.visible !== false; }
    });
    
    // 按位置排序：先按Y坐标（从上到下），再按X坐标（从左到右）
    // 完全解除容差限制，接受所有尺寸差异
    visibleNodes.sort((a, b) => {
      const aY = a.absoluteBoundingBox.y;
      const bY = b.absoluteBoundingBox.y;
      const aX = a.absoluteBoundingBox.x;
      const bX = b.absoluteBoundingBox.x;
      
      // 直接按Y坐标排序，不考虑容差
      if (aY !== bY) {
        return aY - bY;
      }
      // Y坐标相同时，按X坐标排序
      return aX - bX;
    });
    
    // 提取文本内容
    return visibleNodes.map(node => node.characters || '');
    
  } catch (error) {
    console.warn('按顺序提取文本失败，使用递归方式:', error);
    // 回退到递归方式
    const textNodes = getTextNodesInFrameRecursive(frame);
    return textNodes.map(node => node.characters || '');
  }
}

// 按顺序替换文本（从左到右，从上到下）
async function replaceTextsInOrder(frame, texts) {
  try {
    // 获取所有文本节点
    const textNodes = frame.findAllWithCriteria({ types: ['TEXT'] });
    
    // 过滤可见节点
    const visibleNodes = textNodes.filter(function(n){
      try { return isNodeVisibleDeep(n); } catch (_) { return n.visible !== false; }
    });
    
    // 按相同规则排序
    visibleNodes.sort((a, b) => {
      const aY = a.absoluteBoundingBox.y;
      const bY = b.absoluteBoundingBox.y;
      const aX = a.absoluteBoundingBox.x;
      const bX = b.absoluteBoundingBox.x;
      
      // 直接按Y坐标排序，不考虑容差
      if (aY !== bY) {
        return aY - bY;
      }
      // Y坐标相同时，按X坐标排序
      return aX - bX;
    });
    
    // 预加载目标Frame中所有文本节点的字体
    const fontSet = new Set();
    for (const node of visibleNodes) {
      try {
        if (node.fontName !== figma.mixed) {
          const fontKey = `${node.fontName.family}__${node.fontName.style}`;
          fontSet.add(fontKey);
        }
      } catch (_) {}
    }
    
    // 批量加载字体
    for (const fontKey of fontSet) {
      try {
        const [family, style] = fontKey.split('__');
        await figma.loadFontAsync({ family, style });
      } catch (error) {
        console.warn(`字体加载失败: ${fontKey}`, error);
      }
    }
    
    // 按顺序替换文本
    let writeCount = 0;
    const minCount = Math.min(texts.length, visibleNodes.length);
    
    for (let i = 0; i < minCount; i++) {
      const node = visibleNodes[i];
      const newText = texts[i];
      
      // 如果文本内容不同，则替换
      if (node.characters !== newText) {
        try {
          node.characters = newText;
          writeCount++;
        } catch (error) {
          // 组件实例兜底：通过实例属性覆盖
          try {
            const ok = await trySetTextViaInstanceProperty(node, newText);
            if (ok) {
              writeCount++;
            } else {
              console.warn(`写入失败（实例属性匹配不到）: ${node.name}`, error);
            }
          } catch (e2) {
            console.warn(`写入失败（实例属性覆盖异常）: ${node.name}`, e2);
          }
        }
      }
    }
    
    return writeCount;
    
  } catch (error) {
    console.warn('按顺序替换文本失败:', error);
    throw error;
  }
}

// 高性能文本节点收集 - 使用 findAllWithCriteria 避免深度递归
function getTextNodesInFrame(frame) {
  try {
    // 使用 Figma 内置的高效搜索，只查找 TEXT 类型节点
    const nodes = frame.findAllWithCriteria({ types: ['TEXT'] });
    return nodes.filter(function(n){
      try { return isNodeVisibleDeep(n); } catch (_) { return n.visible !== false; }
    });
  } catch (error) {
    console.warn('findAllWithCriteria 失败，使用递归方式:', error);
    // 回退到递归方式
    return getTextNodesInFrameRecursive(frame);
  }
}

// 递归方式收集文本节点（优化版本）
function getTextNodesInFrameRecursive(frame) {
  const textNodes = [];
  let nodeCount = 0;
  const maxNodes = 1000; // 限制最大节点数，防止性能问题
  
  function traverse(node) {
    if (nodeCount >= maxNodes) {
      console.warn('达到最大节点数限制，停止遍历');
      return;
    }
    
    try {
      if (node.visible === false) return; // 不可见分支直接跳过
      if (node.type === 'TEXT' && node.visible !== false) {
        textNodes.push(node);
        nodeCount++;
      } else if (node.children && node.children.length > 0) {
        // 限制子节点数量，防止深度遍历
        const maxChildren = 50;
        const childrenToProcess = node.children.slice(0, maxChildren);
        
        for (let i = 0; i < childrenToProcess.length; i++) {
          traverse(childrenToProcess[i]);
        }
      }
    } catch (error) {
      console.warn('遍历节点时出错:', error);
      // 继续处理其他节点
    }
  }
  
  try {
    traverse(frame);
    console.log(`递归收集到 ${textNodes.length} 个文本节点`);
  } catch (error) {
    console.error('递归遍历失败:', error);
  }
  
  return textNodes;
}

// 空间网格索引类型定义
const createSpatialGrid = (cellSize = 0.06) => {
  const grid = new Map();
  
  const getGridKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  
  const add = (node, pos) => {
    const key = getGridKey(pos.x, pos.y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ node, pos });
  };
  
  const getNeighbors = (pos, radius = 1) => {
    const neighbors = [];
    const centerX = Math.floor(pos.x / cellSize);
    const centerY = Math.floor(pos.y / cellSize);
    
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const key = `${centerX + dx},${centerY + dy}`;
        const bucket = grid.get(key);
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) {
            neighbors.push(bucket[i]);
          }
        }
      }
    }
    return neighbors;
  };
  
  return { add, getNeighbors, grid };
};

// 高性能文本节点索引
function createTextIndex(frame, cellSize = 0.06) {
  console.log(`开始为Frame "${frame.name}" 创建文本索引...`);
  
  try {
    const textNodes = getTextNodesInFrame(frame);
    console.log(`找到 ${textNodes.length} 个文本节点`);
    
    const byName = new Map();
    const spatialGrid = createSpatialGrid(cellSize);
    const used = new Set();
    
    const infos = [];
    for (let i = 0; i < textNodes.length; i++) {
      const node = textNodes[i];
      try {
        const pos = getNormalizedPosition(node, frame);
        const nameKey = (node.name || '').trim();
        
        // 建立同名索引
        if (nameKey) {
          if (!byName.has(nameKey)) byName.set(nameKey, []);
          byName.get(nameKey).push(node);
        }
        
        // 建立空间网格索引
        spatialGrid.add(node, pos);
        
        infos.push({ node: node, pos: pos, nameKey: nameKey });
      } catch (error) {
        console.warn(`处理文本节点 "${node.name}" 时出错:`, error);
        // 跳过有问题的节点，继续处理其他节点
      }
    }
    
    console.log(`成功创建索引，包含 ${infos.length} 个有效文本节点`);
    return { infos, byName, spatialGrid, used };
  } catch (error) {
    console.error(`创建文本索引失败:`, error);
    throw error;
  }
}

// 简化的匹配算法
function findBestTextMatchSimple(baseTextNode, targetTextNodes, threshold, nameOnly = false, anchor = 'center') {
  const baseName = (baseTextNode.name || '').trim();
  const basePos = getNormalizedPosition(baseTextNode, getParentFrame(baseTextNode), anchor);
  
  let bestMatch = null;
  let bestScore = Infinity;
  
  for (let i = 0; i < targetTextNodes.length; i++) {
    const targetNode = targetTextNodes[i];
    let score = Infinity;
    let matchMethod = 'none';
    
    // 1. 同名优先
    if (baseName && (targetNode.name || '').trim() === baseName) {
      score = 0;
      matchMethod = 'name';
    } else if (!nameOnly) {
      // 2. 位置匹配
      const targetPos = getNormalizedPosition(targetNode, getParentFrame(targetNode), anchor);
      const distance = Math.sqrt(
        Math.pow(basePos.x - targetPos.x, 2) + 
        Math.pow(basePos.y - targetPos.y, 2)
      );
      
      if (distance <= threshold) {
        score = distance;
        matchMethod = 'position';
      }
    }
    
    if (score < bestScore) {
      bestScore = score;
      bestMatch = targetNode;
    }
  }
  
  if (bestMatch) {
    console.log(`匹配成功: ${baseTextNode.name} -> ${bestMatch.name} (${bestScore === 0 ? 'name' : 'position'})`);
  } else {
    console.log(`未找到匹配: ${baseTextNode.name}`);
  }
  
  return bestMatch;
}

// 获取节点的父Frame
function getParentFrame(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'FRAME' || current.type === 'GROUP' || current.type === 'COMPONENT' || current.type === 'INSTANCE' || current.type === 'SECTION') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

// 获取归一化位置
function getNormalizedPosition(textNode, frame, anchor) {
  const p = anchorInFrame(frame, textNode, anchor);
  const w = Math.max(1e-6, Number(frame.width) || 0);
  const h = Math.max(1e-6, Number(frame.height) || 0);
  return { x: p.x / w, y: p.y / h };
}

// 检查是否可以写入节点
function canWriteToNode(node) {
  // 检查是否被锁定
  if (node.locked) {
    return false;
  }
  
  // 不再简单排除实例：文本位于实例内部时通常允许覆盖；
  // 对于绑定到组件属性的文本，写入阶段会使用实例属性兜底。
  
  // 检查父节点是否被锁定
  let current = node.parent;
  while (current) {
    if (current.locked) {
      return false;
    }
    current = current.parent;
  }
  
  return true;
}

// 尝试通过“组件实例属性”覆盖文本（适配绑定到文本属性的情况）
async function trySetTextViaInstanceProperty(textNode, value) {
  try {
    // 仅处理 TEXT 节点
    if (!textNode || textNode.type !== 'TEXT') return false;
    // 向上查找最近的实例
    let inst = textNode.parent;
    while (inst && inst.type !== 'INSTANCE') inst = inst.parent;
    if (!inst || typeof inst.setProperties !== 'function') return false;

    const props = inst.componentProperties || {};
    const keys = Object.keys(props);
    if (keys.length === 0) return false;

    // 候选：TEXT 类型的属性
    const textKeys = keys.filter(function(k){
      const p = props[k];
      const t = p && (p.type || p.valueType || p.defaultValueType);
      return p && (p.type === 'TEXT' || t === 'TEXT' || typeof p.value === 'string');
    });
    if (textKeys.length === 0) return false;

    const currentText = (textNode.characters || '').trim();

    // 1) 优先匹配当前值相等的属性（最可靠）
    let cand = textKeys.find(function(k){
      try {
        var v = (props[k] && props[k].value);
        if (v === undefined || v === null) v = '';
        return ('' + v).trim() === currentText;
      } catch (_) { return false; }
    });

    // 2) 次选：按名称近似匹配
    if (!cand) {
      const name = (textNode.name || '').toLowerCase();
      cand = textKeys.find(function(k){ return (k || '').toLowerCase().includes(name) && name.length > 0; });
    }

    // 3) 兜底：只有一个 TEXT 属性时直接使用
    if (!cand && textKeys.length === 1) cand = textKeys[0];

    if (!cand) return false;

    // 设置实例属性
    const patch = {}; patch[cand] = value;
    inst.setProperties(patch);
    return true;
  } catch (_) {
    return false;
  }
}

// OCR同步处理函数
async function handleOCRSync(imageData, frameIds, options = {}) {
  try {
    console.log('开始OCR同步，参数:', { frameIds, options });
    
    updateProgress(5, '获取Frame节点...');
    
    // 获取所有Frame节点
    const frames = [];
    for (let i = 0; i < frameIds.length; i++) {
      const id = frameIds[i];
      const node = await figma.getNodeByIdAsync(id);
      if (node && isSyncContainer(node)) {
        frames.push(node);
      }
    }
    
    if (frames.length === 0) {
      throw new Error('未找到有效的Frame节点');
    }
    
    console.log(`找到 ${frames.length} 个Frame:`, frames.map(f => f.name));
    
    updateProgress(15, 'OCR识别中...');
    
    // 执行OCR识别
    const ocrText = await performOCR(imageData);
    console.log('OCR识别结果:', ocrText);
    
    // 显示OCR结果给用户
    figma.ui.postMessage({
      type: 'ocr-result-display',
      text: ocrText
    });
    
    if (!ocrText || ocrText.trim().length === 0) {
      throw new Error('OCR识别失败，未检测到文字内容');
    }
    
    updateProgress(30, '智能分割文本...');
    
    // 智能分割OCR文本
    const textSegments = intelligentSplitOCR(ocrText, frames);
    console.log('分割结果:', textSegments);
    
    updateProgress(50, '按顺序同步到Frame...');
    
    // 按顺序同步到每个Frame
    let totalWrites = 0;
    let totalSkipped = 0;
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const texts = textSegments[i] || [];
      
      console.log(`同步到Frame: ${frame.name}，文本数量: ${texts.length}`);
      
      try {
        const writes = await replaceTextsInOrder(frame, texts);
        totalWrites += writes;
        console.log(`Frame ${frame.name} 同步完成，写入 ${writes} 个文本`);
      } catch (error) {
        console.warn(`同步Frame ${frame.name} 时出错:`, error);
        totalSkipped++;
      }
      
      // 更新进度
      const progress = 50 + Math.floor((i / frames.length) * 40);
      updateProgress(progress, `同步进度 ${i + 1}/${frames.length}`);
    }
    
    updateProgress(100, 'OCR同步完成');
    
    const message = `OCR同步完成：写入 ${totalWrites} 个文本，跳过 ${totalSkipped} 个Frame`;
    figma.notify(message);
    
    figma.ui.postMessage({
      type: 'sync-summary',
      matchCount: textSegments.flat().length,
      replaceCount: totalWrites,
      unmatchCount: 0,
      skippedCount: totalSkipped,
      lockedCount: 0,
      componentCount: 0
    });
    
  } catch (error) {
    console.error('OCR同步失败:', error);
    figma.ui.postMessage({
      type: 'sync-error',
      error: error.message
    });
  }
}

// OCR识别函数
async function performOCR(imageData) {
  try {
    console.log('执行OCR识别...');
    
    // 由于Figma插件环境限制，无法直接使用Tesseract.js
    // 这里发送图片数据到UI层进行OCR识别
    return new Promise((resolve, reject) => {
      // 设置超时
      const timeout = setTimeout(() => {
        reject(new Error('OCR识别超时'));
      }, 30000);
      
      // 存储resolve和reject函数，供消息处理器使用
      window.ocrResolve = resolve;
      window.ocrReject = reject;
      window.ocrTimeout = timeout;
      
      // 发送图片数据到UI层进行OCR识别
      figma.ui.postMessage({
        type: 'perform-ocr',
        imageData: imageData
      });
    });
    
  } catch (error) {
    console.error('OCR识别失败:', error);
    throw new Error('OCR识别失败: ' + error.message);
  }
}

// 智能分割OCR文本
function intelligentSplitOCR(ocrText, frames) {
  try {
    console.log('开始智能分割OCR文本:', ocrText);
    
    // 获取每个Frame的文本节点数量
    const frameTextCounts = frames.map(frame => {
      try {
        const textNodes = frame.findAllWithCriteria({ types: ['TEXT'] });
        return textNodes.filter(n => n.visible !== false).length;
      } catch (error) {
        console.warn(`获取Frame ${frame.name} 文本节点失败:`, error);
        return 0;
      }
    });
    
    console.log('Frame文本节点数量:', frameTextCounts);
    
    // 策略1：按标点符号分割
    let segments = splitByPunctuation(ocrText);
    console.log('标点符号分割结果:', segments);
    
    // 策略2：按换行符分割（精确）
    if (segments.length === 0) {
      segments = splitByLinesPrecise(ocrText);
      console.log('换行符分割结果（精确）:', segments);
    }
    
    // 策略2.1：按换行符分割（备用）
    if (segments.length === 0) {
      segments = splitByLines(ocrText);
      console.log('换行符分割结果（备用）:', segments);
    }
    
    // 策略3：按平均长度分割
    if (segments.length === 0) {
      const totalTextNodes = frameTextCounts.reduce((sum, count) => sum + count, 0);
      segments = splitByAverageLength(ocrText, totalTextNodes);
      console.log('平均长度分割结果:', segments);
    }
    
    // 按Frame分配文本
    const frameSegments = [];
    let segmentIndex = 0;
    
    for (let i = 0; i < frames.length; i++) {
      const textCount = frameTextCounts[i];
      const frameTexts = [];
      
      for (let j = 0; j < textCount && segmentIndex < segments.length; j++) {
        frameTexts.push(segments[segmentIndex]);
        segmentIndex++;
      }
      
      frameSegments.push(frameTexts);
    }
    
    console.log('最终分配结果:', frameSegments);
    return frameSegments;
    
  } catch (error) {
    console.error('智能分割失败:', error);
    // 回退到简单分割
    return frames.map(() => []);
  }
}

// 按标点符号分割
function splitByPunctuation(text) {
  const segments = text.split(/[。！？\n\r]+/).filter(s => s.trim());
  return segments.map(s => s.trim());
}

// 按换行符分割
function splitByLines(text) {
  const segments = text.split(/\n+/).filter(s => s.trim());
  return segments.map(s => s.trim());
}

// 按行分割（更精确的换行处理）
function splitByLinesPrecise(text) {
  // 先按换行符分割
  const lines = text.split(/\r?\n/);
  const segments = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  
  return segments;
}

// 按平均长度分割
function splitByAverageLength(text, targetCount) {
  if (targetCount <= 0) return [];
  
  const avgLength = Math.floor(text.length / targetCount);
  const segments = [];
  let currentIndex = 0;
  
  for (let i = 0; i < targetCount; i++) {
    let segmentLength = avgLength;
    
    // 最后一个段落获取剩余所有文本
    if (i === targetCount - 1) {
      segmentLength = text.length - currentIndex;
    }
    
    const segment = text.substring(currentIndex, currentIndex + segmentLength);
    segments.push(segment.trim());
    currentIndex += segmentLength;
  }
  
  return segments.filter(s => s.length > 0);
}

// 初始化时检查选择和加载 API Key
try { const p0 = handleSelectionChange(); if (p0 && typeof p0.catch === 'function') p0.catch(e => console.error('init handleSelectionChange error:', e)); } catch (e) { console.error('init selection error:', e); }   
loadApiKey();
