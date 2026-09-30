'use strict';
/*
 * 供应商头像（0.3.9）。
 *
 * 预设图标和自动匹配规则都来自 AllAi（D:\CodePorject\Web\AllAi 的 public/brand/presets 与 lib/preset-icons.ts），
 * 文件复制在 renderer/brand/presets/。单色线稿（mono）在夜间模式下用 CSS 反色。
 *
 * 供应商的 icon 字段：'' = 按名称和地址自动匹配；'letter' = 用名字首字母；其余是预设 id。
 * avatar 字段是用户上传的小图（data URL），优先级最高。
 */
(() => {
  const PRESETS = [
    ['claude', 'claude-color.svg', 'Claude', ['claude', 'sonnet', 'opus', 'haiku', 'anthropic'], true],
    ['anthropic', 'anthropic.svg', 'Anthropic', ['anthropic'], false],
    ['grok', 'grok.svg', 'Grok', ['grok', 'xai', 'x.ai'], false],
    ['openai', 'openai.svg', 'OpenAI', ['openai', 'chatgpt', 'gpt-4', 'gpt-5', 'gpt-3', 'dall-e', 'sora', 'whisper', 'codex'], false],
    ['gemini', 'gemini-color.svg', 'Gemini', ['gemini', 'gemma', 'imagen', 'google.ai', 'googleapis', 'generativelanguage'], true],
    ['deepmind', 'deepmind-color.svg', 'DeepMind', ['deepmind'], true],
    ['deepseek', 'deepseek-color.svg', 'DeepSeek', ['deepseek'], true],
    ['qwen', 'qwen-color.svg', '通义千问', ['qwen', 'qwq', 'qvq', 'tongyi', 'dashscope'], true],
    ['alibaba', 'alibaba-color.svg', '阿里巴巴', ['alibaba.com', 'alibaba'], true],
    ['alibabacloud', 'alibabacloud-color.svg', '阿里云', ['aliyun', 'alibabacloud', 'aliyun.com', 'alibabacloud.com'], true],
    ['bailian', 'bailian-color.svg', '阿里云百炼', ['bailian', 'bailian.aliyun'], true],
    ['kimi', 'kimi.svg', 'Kimi', ['kimi', 'moonshot'], false],
    ['chatglm', 'chatglm-color.svg', '智谱 GLM', ['chatglm', 'glm', 'zhipu', 'bigmodel'], true],
    ['zai', 'zai.svg', 'Z.ai', ['zai-org', 'z.ai', 'zai.'], false],
    ['doubao', 'doubao-color.svg', '豆包', ['doubao', 'skylark', 'seed-oss'], true],
    ['bytedance', 'bytedance-color.svg', '字节跳动', ['bytedance', 'volcengine', 'volces'], true],
    ['tencentcloud', 'tencentcloud-color.svg', '腾讯云', ['tencentcloud', 'tencent', 'hunyuan', 'qcloud'], true],
    ['baiducloud', 'baiducloud-color.svg', '百度智能云', ['baiducloud', 'baidubce', 'qianfan', 'ernie', 'wenxin', 'baidu.com'], true],
    ['meta', 'meta-color.svg', 'Meta', ['meta-llama', 'llama', 'meta.com'], true],
    ['microsoft', 'microsoft-color.svg', 'Microsoft', ['microsoft', 'azure', 'phi-'], true],
    ['copilot', 'copilot-color.svg', 'GitHub Copilot', ['copilot', 'github'], true],
    ['huaweicloud', 'huaweicloud-color.svg', '华为云', ['huaweicloud', 'huawei', 'pangu', 'myhuaweicloud'], true],
    ['luma', 'luma-color.svg', 'Luma', ['luma', 'lumalabs', 'dream-machine'], true],
    ['midjourney', 'midjourney.svg', 'Midjourney', ['midjourney'], false],
    ['ollama', 'ollama.svg', 'Ollama', ['ollama'], false],
  ].map(([id, file, label, keywords, color]) => ({ id, src: 'brand/presets/' + file, label, keywords, mono: !color }));

  function hostOf(text) {
    const raw = String(text || '').trim().toLowerCase();
    if (!raw) return '';
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw).hostname.replace(/^www\./, ''); } catch { return raw; }
  }
  /** AllAi 的打分：完全相同 > 域名命中 > 域名包含 > 文本包含；分太低当没认出来。 */
  function score(icon, hay, host) {
    let total = 0;
    for (const keyword of icon.keywords) {
      const key = keyword.toLowerCase();
      if (hay === key) total += 80 + key.length;
      else if (host === key || host.endsWith('.' + key)) total += 70 + key.length;
      else if (host.includes(key)) total += 40 + key.length * 3;
      else if (hay.includes(key)) total += 10 + key.length * 2;
    }
    return total;
  }
  /** 地址比名字可靠（名字常是「主力线路」这种），分开算、地址优先。 */
  function bestPreset(name, baseUrl) {
    let best = null;
    for (const [text, weight] of [[baseUrl, 2], [name, 1]]) {
      const hay = String(text || '').trim().toLowerCase();
      if (!hay) continue;
      const host = hostOf(hay);
      for (const icon of PRESETS) {
        const value = score(icon, hay, host) * weight;
        if (value >= 16 && (!best || value > best.value)) best = { icon, value };
      }
    }
    return best?.icon || null;
  }
  const byId = id => PRESETS.find(item => item.id === id) || null;
  /** 这一家现在用哪张图：{ src, mono, label } 或 null（用首字母）。 */
  function resolve(provider) {
    if (!provider) return null;
    if (provider.avatar) return { src: provider.avatar, mono: false, label: '自定义头像' };
    if (provider.icon === 'letter') return null;
    const preset = byId(provider.icon) || (!provider.icon ? bestPreset(provider.name, provider.baseUrl) : null);
    return preset ? { src: preset.src, mono: preset.mono, label: preset.label } : null;
  }
  /**
   * 上传的图片缩成 128px 的 PNG：头像只需要这么大，也免得几 MB 的原图进了数据文件。
   * SVG 同样画到画布上再导出，存下来的一定是位图。
   */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) { reject(new Error('请选择 PNG、JPG、WebP、GIF 或 SVG 图片')); return; }
      if (file.size > 5 * 1024 * 1024) { reject(new Error('图片不能超过 5 MB')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('这张图片打不开'));
        img.onload = () => {
          const size = 128, canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          const w = img.naturalWidth || size, h = img.naturalHeight || size, scale = Math.max(size / w, size / h);
          ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
          resolve(canvas.toDataURL('image/png'));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }
  window.PulseAvatars = { PRESETS, bestPreset, resolve, readImage, byId };
})();
