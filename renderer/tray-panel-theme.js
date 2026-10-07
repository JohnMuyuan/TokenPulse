'use strict';
// 主进程把主题放在地址里（?theme=dark），在第一帧之前就定好，免得先亮一下再变暗。
if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
