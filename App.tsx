// 标签组件
function ActiveTab() {
  return (
    <div className="box-border content-stretch flex items-center justify-center px-0 py-3 relative shrink-0">
      <div aria-hidden="true" className="absolute border-[#222222] border-[0px_0px_3px] border-solid inset-0 pointer-events-none" />
      <div className="font-['PingFang_SC:Medium',_sans-serif] not-italic relative shrink-0 text-[#222222] text-[12px] leading-[17px]">
        <span className="m-0 p-0">生成文本</span>
      </div>
    </div>
  );
}

function InactiveTab({ children }: { children: string }) {
  return (
    <div className="box-border content-stretch flex items-center justify-center px-0 py-3 relative shrink-0">
      <div className="font-['PingFang_SC:Regular',_sans-serif] not-italic relative shrink-0 text-[#aaaaaa] text-[12px] leading-[17px]">
        <span className="m-0 p-0">{children}</span>
      </div>
    </div>
  );
}

function TabBar() {
  return (
    <div className="absolute box-border content-stretch flex gap-[18px] items-center justify-start left-0 px-5 py-0 top-0 w-80">
      <div aria-hidden="true" className="absolute border-[#cccccc] border-[0px_0px_0.5px] border-solid inset-0 pointer-events-none" />
      <ActiveTab />
      <InactiveTab>多帧同步</InactiveTab>
      <InactiveTab>字体替换</InactiveTab>
      <InactiveTab>翻译</InactiveTab>
    </div>
  );
}

// API Key 相关组件
function ApiKeySection() {
  return (
    <div className="content-stretch flex flex-col gap-1 items-start justify-start relative shrink-0 w-full">
      <div className="font-['PingFang_SC:Regular',_sans-serif] not-italic text-[#222222] text-[12px] leading-[17px] w-full">
        <span className="m-0 p-0">API Key</span>
      </div>
      <div className="content-stretch flex gap-2 items-start justify-start relative shrink-0 w-full">
        <input
          placeholder="***"
          className="h-8 w-full px-2 border border-[#CCCCCC] rounded-[4px] text-[12px] leading-[17px] text-[#111111] placeholder:text-[#CCCCCC] outline-none"
          type="password"
        />
        <button className="btn-secondary w-[44px] shrink-0">保存</button>
      </div>
    </div>
  );
}

// 选择状态组件
function SelectionStatus() {
  return (
    <div className="content-stretch flex flex-col gap-1 items-start justify-start relative shrink-0 w-full">
      <div className="font-['PingFang_SC:Regular',_sans-serif] text-[12px] leading-[17px] text-[#222222] w-full">
        <span className="m-0 p-0">选择状态</span>
      </div>
      <div className="font-['PingFang_SC:Regular',_sans-serif] text-[12px] leading-[17px] text-[#AAAAAA] w-[276px] h-[17px]">
        请选择任意对象或文本，插件将翻译其内部所有文本
      </div>
    </div>
  );
}

// Prompt 相关组件
function PromptInputArea() {
  return (
    <div className="content-stretch flex flex-col gap-1 items-start justify-start relative rounded-[4px] shrink-0 w-full">
      <textarea
        placeholder="例如：人名"
        className="h-[100px] w-full resize-none border border-[#CCCCCC] rounded-[4px] text-[12px] leading-[17px] text-[#111111] placeholder:text-[#CCCCCC] outline-none p-2"
      />
    </div>
  );
}

function PromptSection() {
  return (
    <div className="content-stretch flex flex-col gap-1 items-start justify-start relative shrink-0 w-full">
      <div className="font-['PingFang_SC:Regular',_sans-serif] not-italic relative shrink-0 text-[#222222] text-[12px] leading-[17px] w-full">
        <span className="m-0 p-0">文案生成 Prompt</span>
      </div>
      <PromptInputArea />
    </div>
  );
}

// 生成按钮组件
function GenerateSection() {
  return (
    <div className="box-border content-stretch flex flex-col gap-2 items-start justify-start pb-0 pt-2 px-0 relative shrink-0 w-full">
      <button className="w-full h-[25px] rounded-[4px] bg-[#222222] text-white text-[12px] leading-[17px]">生成</button>
      {/* 执行中才显示的“停止”按钮由容器上层控制，这里仅保留样式 */}
    </div>
  );
}

// 进度条组件
function ProgressText() {
  return (
    <div className="content-stretch flex font-['PingFang_SC:Regular',_sans-serif] gap-1 items-start justify-start not-italic relative shrink-0 text-[#222222] text-[12px] leading-[17px]">
      <span className="m-0 p-0">进度</span>
      <span className="m-0 p-0">75%</span>
    </div>
  );
}

function ProgressBarFill() {
  return <div className="absolute bg-[#222222] h-[3px] left-0 rounded-[4px] top-0 w-[186px]" />;
}

function ProgressBar() {
  return (
    <div className="bg-[#cccccc] h-[3px] overflow-clip relative rounded-[4px] shrink-0 w-full" data-name="进度条">
      <ProgressBarFill />
    </div>
  );
}

function ProgressSection() {
  return (
    <div className="content-stretch flex flex-col gap-1 items-start justify-center relative shrink-0 w-full" data-name="同步进度">
      <ProgressText />
      <ProgressBar />
    </div>
  );
}

// 主内容区域
import { useState, useEffect } from 'react';

function MainContent() {
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!generating) return;
    setProgress(0);
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(100, Math.floor((t - start) / 20));
      setProgress(p);
      if (p < 100) raf = requestAnimationFrame(step);
      else setGenerating(false);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [generating]);

  return (
    <div className="absolute content-stretch flex flex-col gap-6 items-start justify-start left-5 top-[66px] w-[280px]">
      <ApiKeySection />
      <SelectionStatus />
      <PromptSection />

      {/* 按钮区：顶部 +8，按钮间距 8 */}
      <div className="box-border content-stretch flex flex-col gap-2 items-start justify-start pb-0 pt-2 px-0 relative shrink-0 w-full">
        <button
          className="w-full h-[25px] rounded-[4px] bg-[#222222] text-white text-[12px] leading-[17px]"
          onClick={() => setGenerating(true)}
          disabled={generating}
        >
          生成
        </button>
        {generating && (
          <button className="btn-secondary w-full" onClick={() => setGenerating(false)}>停止</button>
        )}
      </div>

      {/* 进度：执行中才展示 */}
      {generating && (
        <div className="content-stretch flex flex-col gap-1 items-start justify-center relative shrink-0 w-full">
          <div className="flex gap-1 text-[12px] leading-[17px] text-[#222222]">
            <div>进度</div>
            <div>{progress}%</div>
          </div>
          <div className="relative w-full h-[3px] rounded-[4px] bg-[#CCCCCC] overflow-hidden">
            <div className="absolute left-0 top-0 h-[3px] bg-[#222222] rounded-[4px]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <div className="bg-white relative size-full" data-name="生成文本">
      <TabBar />
      <MainContent />
    </div>
  );
}
