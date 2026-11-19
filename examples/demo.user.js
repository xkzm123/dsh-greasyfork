// ==UserScript==
// @name         DSH GreasyFork 示例脚本
// @name:zh-CN   DSH GreasyFork 示例脚本
// @namespace    https://example.com/dsh-greasyfork-demo
// @version      1.0.0
// @description  演示用脚本：在 example.com 页面右下角显示一个小徽标。
// @description:zh-CN  演示用脚本：在 example.com 页面右下角显示一个小徽标。
// @author       you
// @match        https://example.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict'

  const badge = document.createElement('div')
  badge.textContent = 'dsh-greasyfork demo v1.0.0'
  Object.assign(badge.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '6px 10px',
    borderRadius: '6px',
    background: 'rgba(20, 20, 20, 0.85)',
    color: '#fff',
    font: '12px/1.4 system-ui, sans-serif',
    pointerEvents: 'none'
  })
  document.body.appendChild(badge)
})()
