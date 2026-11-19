// ==UserScript==
// @name         DSH GreasyFork 示例脚本
// @name:zh-CN   DSH GreasyFork 示例脚本
// @namespace    https://example.com/dsh-greasyfork-demo
// @version      1.1.0
// @description  演示用脚本（v1.1）：徽标可点击跳转到 GreasyFork 页面。
// @description:zh-CN  演示用脚本（v1.1）：徽标可点击跳转到 GreasyFork 页面。
// @author       you
// @match        https://example.com/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict'

  const badge = document.createElement('a')
  badge.textContent = 'dsh-greasyfork demo v1.1.0'
  badge.href = 'https://greasyfork.org/'
  badge.target = '_blank'
  badge.rel = 'noopener'
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
    textDecoration: 'none'
  })
  document.body.appendChild(badge)
})()
