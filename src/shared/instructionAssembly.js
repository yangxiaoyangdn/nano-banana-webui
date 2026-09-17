// 把风格库六字段档案拼装成 AI 能理解的指令。
// 顺序固定为 Nano Banana Pro 官方推荐写法：主体 → 环境 → 构图 → 风格 → 特殊要求。
// “禁用项”作为强制的负面约束追加在末尾，不参与顺序但必须始终生效。
export function assembleStyleInstruction(style, specialRequirements) {
    const parts = []

    const push = value => {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text) parts.push(text)
    }

    push(style?.subject) // 主体
    push(style?.environment) // 环境
    push(style?.composition) // 构图
    push(style?.colorGrading) // 风格（色彩分级）

    const special = typeof specialRequirements === 'string' ? specialRequirements.trim() : ''
    if (special) parts.push(`特殊要求：${special}`)

    const forbidden = typeof style?.forbidden === 'string' ? style.forbidden.trim() : ''
    if (forbidden) parts.push(`禁止出现：${forbidden}`)

    return parts.join('\n')
}
