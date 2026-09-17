<template>
    <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
            <div>
                <h4 class="font-bold text-dark-text">📦 批量导入（Excel）</h4>
                <p class="text-xs text-dark-muted">每一行 = 一个出图任务：参考图链接 + 风格名称 + 标准/品牌模式，其余出图参数用当前工作区里选的这一套</p>
            </div>
            <div class="flex items-center gap-2">
                <input ref="fileInput" type="file" accept=".xlsx" class="hidden" @change="handleFile" />
                <BaseButton variant="secondary" class="text-sm py-1.5 px-3" @click="emit('download-template')">
                    ⬇️ 下载模板
                </BaseButton>
                <BaseButton
                    variant="primary"
                    class="text-sm py-1.5 px-3"
                    :loading="importing"
                    :disabled="importing"
                    @click="fileInput?.click()"
                >
                    ⬆️ 选择文件导入
                </BaseButton>
            </div>
        </div>

        <div v-if="result" class="text-sm bg-dark-bg border border-dark-border rounded-lg p-3 space-y-1">
            <p class="font-semibold text-dark-text">
                导入完成：成功 {{ result.imported }} 条，失败 {{ result.failed.length }} 条
            </p>
            <ul v-if="result.failed.length" class="text-xs text-dark-danger space-y-0.5 max-h-32 overflow-y-auto">
                <li v-for="item in result.failed" :key="item.row">第 {{ item.row }} 行：{{ item.reason }}</li>
            </ul>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import BaseButton from './BaseButton.vue'
import type { TaskImportResponse } from '../types'

defineProps<{
    importing: boolean
    result: TaskImportResponse | null
}>()

const emit = defineEmits<{
    'download-template': []
    'import-file': [fileBase64: string]
}>()

const fileInput = ref<HTMLInputElement>()

const handleFile = (event: Event) => {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
        if (e.target?.result) {
            emit('import-file', e.target.result as string)
        }
    }
    reader.readAsDataURL(file)
}
</script>
