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

// 同步取消标志
let isSyncCancelled = false;

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
            }, 30000); // 30秒超时
          });
          
          // 检查是否使用高性能位置键算法
          if (msg.options && msg.options.usePositionKey) {
            console.log('使用高性能位置键算法');
            console.log('调用参数:', {
              frameIds: msg.frameIds,
              sourceFrameId: msg.sourceFrameId,
              threshold: msg.threshold,
              includeSourceFrame: msg.includeSourceFrame,
              options: msg.options
            });
            
            const syncPromise = syncByPositionKey(msg.frameIds, msg.sourceFrameId, msg.threshold, msg.includeSourceFrame, msg.options);
            await Promise.race([syncPromise, timeoutPromise]);
          } else {
            console.log('使用简化同步算法');
            const syncPromise = syncFrames(msg.frameIds, msg.sourceFrameId, msg.threshold, msg.includeSourceFrame, msg.options);
            await Promise.race([syncPromise, timeoutPromise]);
          }
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
    }
  } catch (error) {
    console.error('插件错误:', error);
    figma.ui.postMessage({ 
      type: 'generate-error', 
      error: error.message 
    });
  }
};

// 处理选择变化
function handleSelectionChange() {
  const selection = figma.currentPage.selection;
  selectedTextNodes = selection.filter(node => node.type === 'TEXT');
  const selectedFrames = selection.filter(node => node.type === 'FRAME');
  
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
    })
  });
}

// 监听选择变化事件
figma.on('selectionchange', function() {
  handleSelectionChange();
});

// 生成文案的主要函数
async function generateText(prompt, apiKey, nodeIds) {
  try {
    // 验证输入
    if (!prompt || !apiKey || !nodeIds || nodeIds.length === 0) {
      throw new Error('缺少必要参数');
    }

    // 获取要更新的文本节点
    const textNodes = nodeIds
      .map(id => figma.getNodeById(id))
      .filter(node => node && node.type === 'TEXT');

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
          content: `你是一个专业的文案生成助手。请严格按照以下要求批量生成文案：

【核心要求】
1. 需要生成 ${totalCount} 个不同的文案
2. 每个文案都要独特且有创意，避免重复或相似
3. 输出内容要精准、简洁，符合中文表达习惯
4. 不要包含引号、括号或其他标点符号（除非用户明确要求）
5. 输出格式：每行一个文案，用换行符分隔

【批量生成规则】
- 第1个文案：${totalCount >= 1 ? '生成第1个文案' : ''}
- 第2个文案：${totalCount >= 2 ? '生成第2个文案，与第1个有明显区别' : ''}
- 第3个文案：${totalCount >= 3 ? '生成第3个文案，与前两个都有明显区别' : ''}
- 第4个文案：${totalCount >= 4 ? '生成第4个文案，与前三个都有明显区别' : ''}
- 第5个文案：${totalCount >= 5 ? '生成第5个文案，与前四个都有明显区别' : ''}

【常见场景示例】
- 快递单号：SF123456789、YT987654321、JD456789123
- 公司名称：创新科技有限公司、智慧生活服务有限公司、绿色能源科技股份有限公司
- 产品名称：智能手环、无线充电器、高清摄像头
- 按钮文案：立即购买、马上抢购、加入购物车
- 标题文案：创新科技引领未来、智能生活从这里开始

【参考格式支持】
- 当用户提供参考格式时（如"参考：P0\\P1"），必须严格按照该格式生成
- 格式中的数字会自动递增（P0→P1→P2...）
- 输出内容必须完全匹配指定的格式模板

【输出要求】
- 严格按照要求的数量生成文案
- 每个文案都要有显著差异
- 直接输出文案，每行一个，不要编号或前缀`
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
  const abs = node.absoluteTransform;
  const ctr = apply(abs, node.width / 2, node.height / 2);
  const inv = invert(frame.absoluteTransform);
  return apply(inv, ctr.x, ctr.y);
}

function norm(frame, p) {
  return { nx: p.x / frame.width, ny: p.y / frame.height };
}

// 收集文本节点（优化版本）
function collectTexts(frame) {
  try {
    // 先尝试使用递归方式，更稳定
    return getTextNodesInFrameRecursive(frame);
  } catch (error) {
    console.warn('递归方式失败，尝试findAllWithCriteria:', error);
    try {
      const nodes = frame.findAllWithCriteria({ types: ['TEXT'] });
      return nodes.filter(function(n) {
        return n.visible !== false;
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
  
  const texts = collectTexts(frame);
  const infos = [];
  
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const p = norm(frame, centerInFrame(frame, t));
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
    
    // 使用固定的优化参数
    const cell = 0.02;      // 2% 网格
    const tol = 0.06;       // 6% 距离阈值
    const useSize = true;   // 叠加尺寸维度
    const nameFirst = true; // 同名优先
    const nameOnly = false; // 不使用仅同名模式
    const posOnly = false;  // 不使用仅位置键模式
    const batch = 100;      // 写入批大小

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
        const node = figma.getNodeById(id);
        console.log(`节点 ${id} 获取结果:`, node ? node.type : 'null');
        
        if (node && node.type === 'FRAME') {
          frames.push(node);
          console.log(`成功添加Frame: ${node.name}`);
        } else {
          console.warn(`节点 ${id} 不是Frame类型或不存在`);
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
    
    try {
      const pivotIndex = indexFrameByPos(sourceFrame, { cell: cell, useSize: useSize });
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
        const targetIndex = indexFrameByPos(frame, { cell: cell, useSize: useSize });
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
          // 忽略单点失败
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

// 简化的多帧同步功能（测试版本）
async function syncFrames(frameIds, sourceFrameId, threshold = 0.08, includeSourceFrame = false, options = {}) {
  try {
    console.log('开始同步函数，参数:', { frameIds, sourceFrameId, threshold, includeSourceFrame, options });
    
    const {
      nameOnly = false,        // 仅同名匹配模式（极速）
      cellSize = 0.06,         // 空间网格单元大小
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
      const node = figma.getNodeById(id);
      console.log(`获取节点 ${id}:`, node ? node.type : 'null');
      if (node && node.type === 'FRAME') {
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
    
    // 简化版本：直接获取文本节点
    updateProgress(20, '获取文本节点...');
    console.log('开始获取源Frame文本节点...');
    
    let sourceTextNodes;
    try {
      sourceTextNodes = getTextNodesInFrame(sourceFrame);
      console.log(`源Frame "${sourceFrame.name}" 包含 ${sourceTextNodes.length} 个文本节点`);
    } catch (error) {
      console.error('获取源Frame文本节点失败:', error);
      throw new Error(`获取源Frame文本节点失败: ${error.message}`);
    }
    
    if (sourceTextNodes.length === 0) {
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

    // 简化版本：获取目标Frame
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

    let totalMatches = 0;
    let totalWrites = 0;
    let totalMisses = 0;
    let lockedCount = 0;
    let componentCount = 0;
    const pendingWrites = []; // 待写入的节点列表

    // 简化匹配阶段
    updateProgress(40, '开始匹配文本节点...');
    const totalSourceNodes = sourceTextNodes.length;
    
    for (let i = 0; i < sourceTextNodes.length; i++) {
      // 检查是否已取消
      if (isSyncCancelled) {
        figma.ui.postMessage({ type: 'sync-cancelled' });
        return;
      }
      
      const sourceNode = sourceTextNodes[i];
      const matchedNodes = [];
      
      // 更新匹配进度
      const matchProgress = 40 + Math.floor((i / totalSourceNodes) * 30);
      updateProgress(matchProgress, `匹配节点 ${i + 1}/${totalSourceNodes}`);

      // 为每个目标Frame找到匹配的节点（简化版本）
      for (let j = 0; j < targetFrames.length; j++) {
        const targetFrame = targetFrames[j];
        try {
          const targetTextNodes = getTextNodesInFrame(targetFrame);
          const bestMatch = findBestTextMatchSimple(sourceNode, targetTextNodes, threshold, nameOnly);
          
          if (bestMatch) {
            matchedNodes.push(bestMatch);
            totalMatches++;
          } else {
            totalMisses++;
          }
        } catch (error) {
          console.warn(`处理目标Frame "${targetFrame.name}" 时出错:`, error);
          totalMisses++;
        }
      }

      if (matchedNodes.length === 0) continue;

      // 确定统一内容
      let unifiedContent = sourceNode.characters;
      if (!unifiedContent || !unifiedContent.trim()) {
        // 源Frame为空时，使用第一个非空候选
        for (let k = 0; k < matchedNodes.length; k++) {
          const node = matchedNodes[k];
          if (node.characters && node.characters.trim()) {
            unifiedContent = node.characters;
            break;
          }
        }
      }

      if (!unifiedContent) continue;

      // 收集需要写入的节点（跳过内容相同的）
      for (let k = 0; k < matchedNodes.length; k++) {
        const targetNode = matchedNodes[k];
        if (targetNode.characters !== unifiedContent) {
          if (canWriteToNode(targetNode)) {
            pendingWrites.push({ node: targetNode, content: unifiedContent });
          } else {
            // 记录跳过原因
            if (targetNode.locked) {
              lockedCount++;
            } else if (targetNode.type === 'INSTANCE') {
              componentCount++;
            }
          }
        }
      }
    }

    if (dryRun) {
      // 干跑模式：只显示统计信息
      const message = `预览完成：匹配 ${totalMatches} 处，将写入 ${pendingWrites.length} 个，未匹配 ${totalMisses}`;
      if (lockedCount > 0 || componentCount > 0) {
        const skipDetails = [];
        if (lockedCount > 0) skipDetails.push(`锁定 ${lockedCount}`);
        if (componentCount > 0) skipDetails.push(`组件 ${componentCount}`);
        message += `，跳过 ${skipDetails.join('、')} 个`;
      }
      
      figma.notify(message);
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: totalMatches,
        replaceCount: pendingWrites.length,
        unmatchCount: totalMisses,
        skippedCount: lockedCount + componentCount,
        lockedCount,
        componentCount,
        dryRun: true
      });
      return;
    }

    if (pendingWrites.length === 0) {
      figma.notify(`同步完成：匹配 ${totalMatches} 处，无需修改`);
      figma.ui.postMessage({
        type: 'sync-summary',
        matchCount: totalMatches,
        replaceCount: 0,
        unmatchCount: totalMisses,
        skippedCount: lockedCount + componentCount,
        lockedCount,
        componentCount
      });
      return;
    }

    // 批量加载字体
    updateProgress(80, '加载字体...');
    console.log(`开始批量加载字体，共 ${pendingWrites.length} 个节点`);
    const fontMap = await collectFontsForNodes(pendingWrites.map(function(w) {
      return w.node;
    }));
    await loadFontsBatch(fontMap);
    console.log(`字体加载完成，共 ${fontMap.size} 种字体`);
    
    // 检查是否已取消
    if (isSyncCancelled) {
      figma.ui.postMessage({ type: 'sync-cancelled' });
      return;
    }

    // 分批写入，避免阻塞UI
    updateProgress(85, '写入文本内容...');
    console.log(`开始分批写入，每批 ${batchSize} 个节点`);
    for (let i = 0; i < pendingWrites.length; i += batchSize) {
      // 检查是否已取消
      if (isSyncCancelled) {
        figma.ui.postMessage({ type: 'sync-cancelled' });
        return;
      }
      
      const batch = pendingWrites.slice(i, i + batchSize);
      
      for (const write of batch) {
        try {
          write.node.characters = write.content;
          totalWrites++;
        } catch (error) {
          console.warn(`写入失败: ${write.node.name}`, error);
        }
      }
      
      // 更新写入进度
      const writeProgress = 85 + Math.floor(((i + batchSize) / pendingWrites.length) * 10);
      updateProgress(Math.min(writeProgress, 95), `写入进度 ${Math.min(i + batchSize, pendingWrites.length)}/${pendingWrites.length}`);
      
      // 让出事件循环，避免阻塞UI
      if (i + batchSize < pendingWrites.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // 发送同步结果
    updateProgress(100, '同步完成！');
    const message = `同步完成：匹配 ${totalMatches} 处，成功写入 ${totalWrites}，未匹配 ${totalMisses}`;
    if (lockedCount > 0 || componentCount > 0) {
      const skipDetails = [];
      if (lockedCount > 0) skipDetails.push(`锁定 ${lockedCount}`);
      if (componentCount > 0) skipDetails.push(`组件 ${componentCount}`);
      message += `，跳过 ${skipDetails.join('、')} 个`;
    }
    
    figma.notify(message);
    console.log(`高性能同步完成: ${message}`);

    figma.ui.postMessage({
      type: 'sync-summary',
      matchCount: totalMatches,
      replaceCount: totalWrites,
      unmatchCount: totalMisses,
      skippedCount: lockedCount + componentCount,
      lockedCount,
      componentCount
    });

  } catch (error) {
    console.error('高性能多帧同步失败:', error);
    figma.ui.postMessage({
      type: 'sync-error',
      error: error.message 
    });
  }
}

// 高性能文本节点收集 - 使用 findAllWithCriteria 避免深度递归
function getTextNodesInFrame(frame) {
  try {
    // 使用 Figma 内置的高效搜索，只查找 TEXT 类型节点
    return frame.findAllWithCriteria({ types: ['TEXT'] });
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
function findBestTextMatchSimple(baseTextNode, targetTextNodes, threshold, nameOnly = false) {
  const baseName = (baseTextNode.name || '').trim();
  const basePos = getNormalizedPosition(baseTextNode, getParentFrame(baseTextNode));
  
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
      const targetPos = getNormalizedPosition(targetNode, getParentFrame(targetNode));
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
    if (current.type === 'FRAME') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

// 获取归一化位置
function getNormalizedPosition(textNode, frame) {
  const nodeCenter = {
    x: textNode.x + textNode.width / 2,
    y: textNode.y + textNode.height / 2
  };
  
  return {
    x: nodeCenter.x / frame.width,
    y: nodeCenter.y / frame.height
  };
}

// 检查是否可以写入节点
function canWriteToNode(node) {
  // 检查是否被锁定
  if (node.locked) {
    return false;
  }
  
  // 检查是否是组件实例
  if (node.type === 'INSTANCE') {
    return false;
  }
  
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

// 初始化时检查选择和加载 API Key
handleSelectionChange();
loadApiKey();
