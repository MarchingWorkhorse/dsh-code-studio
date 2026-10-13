/**
 * 差异审查测试文件 —— 用于验证 VSCode 式审查视图。
 * 本文件会被 agent 修改数次，产生多个待处理差异块。
 */

function greet(name) {
  const greeting = '你好，'
  return greeting + name + '！'
}

function add(a, b) {
  const sum = Number(a) + Number(b)
  return Number.isFinite(sum) ? sum : 0
}

function multiply(a, b) {
  return Number(a) * Number(b)
}

function legacyOld(input) {
  // 旧的实现，等待被 agent 修改
  var result = ''
  for (var i = 0; i < input.length; i++) {
    result += input[i]
  }
  return result
}

module.exports = { greet, add, multiply, legacyOld }
