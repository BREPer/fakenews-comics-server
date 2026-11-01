/**
 * 启动壳（首屏等待期间的骨架）。
 *
 * 为什么要有这个组件：`index.html` 里的静态启动壳会被 React 挂载时整体替换掉，
 * 于是「骨架」会退化成「spinner + 一行字」再变首页 —— 那 200ms 的降级就是用户
 * 能看到的唯一接缝（实测弱网下首屏守卫只活 122–206ms，吉祥物根本来不及出场）。
 * 这里把同一份标记做成组件，让 React 接管后**继续显示同样的骨架**，
 * 直到等待超过 SHELL_HOLD_MS 才换成带吉祥物的等待页。
 *
 * ⚠️ 标记必须与 `index.html` 的 `<div class="boot">` 逐字对应，改一处就改两处：
 *    - `index.html` 的那份负责「JS 到达前」（1 Mbps 下要顶 3.9 秒）
 *    - 这份负责「JS 到达后、等待结束前」
 *    - **样式只存在于 `index.html` 的内联 <style> 里，别搬进 index.css**：
 *      CSS 包 1 Mbps 下要 1.1 秒才到，写在包里等于首屏没有壳
 *
 * 尺寸/间距/配色都由那段内联 CSS 决定（`.boot` 及其子类），这里只管结构。
 */
export default function BootShell() {
  return (
    <div className="boot" aria-hidden="true">
      <div className="row">
        <div className="mark" />
        <span className="name">肥牛漫画</span>
      </div>
      <div className="sk search" />
      <div className="strip">
        <div className="sk" />
        <div className="sk" />
      </div>
      <div className="grid">
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
        <div className="sk" />
      </div>
    </div>
  );
}
