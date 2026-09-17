<template>
    <div class="h-full flex flex-col gap-4">
        <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex bg-dark-bg rounded-lg p-1 border border-dark-border">
                <button
                    @click="activeTab = 'style'"
                    :class="[
                        'flex-1 py-1.5 px-3 rounded-md font-bold transition-all flex items-center justify-center gap-2 text-sm',
                        activeTab === 'style' ? 'bg-dark-surfaceHighlight text-dark-accent shadow-sm' : 'text-dark-muted hover:text-dark-text'
                    ]"
                >
                    🍱 风格库
                </button>
                <button
                    @click="activeTab = 'custom'"
                    :class="[
                        'flex-1 py-1.5 px-3 rounded-md font-bold transition-all flex items-center justify-center gap-2 text-sm',
                        activeTab === 'custom' ? 'bg-dark-surfaceHighlight text-dark-accent shadow-sm' : 'text-dark-muted hover:text-dark-text'
                    ]"
                >
                    ✍️ 自定义
                </button>
            </div>
            <div class="flex items-center gap-2">
                <input ref="importInput" type="file" accept=".xlsx" class="hidden" @change="handleImportFile" />
                <BaseButton
                    @click="emit('export-templates')"
                    variant="secondary"
                    class="text-sm py-1.5 px-3"
                    title="导出为 Excel"
                >
                    ⬇️ 导出
                </BaseButton>
                <BaseButton
                    @click="importInput?.click()"
                    variant="secondary"
                    class="text-sm py-1.5 px-3"
                    title="从 Excel 导入"
                >
                    ⬆️ 导入
                </BaseButton>
                <BaseButton
                    @click="openCreateForm"
                    variant="secondary"
                    class="text-sm py-1.5 px-3"
                >
                    ➕ 新建风格
                </BaseButton>
            </div>
        </div>

        <div v-if="activeTab === 'style'" class="flex-1 overflow-y-auto custom-scrollbar pr-1 flex flex-col gap-3">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                    v-for="template in paginatedTemplates"
                    :key="template.id"
                    @click="selectStyle(template.id)"
                    :class="[
                        'p-3 rounded-xl border cursor-pointer transition-all duration-200 group min-h-[88px]',
                        selectedStyle === template.id
                            ? 'bg-dark-surfaceHighlight border-dark-accent shadow-glow'
                            : 'bg-dark-bg border-dark-border hover:border-dark-muted/50'
                    ]"
                >
                    <div class="flex items-start gap-3">
                        <img
                            v-if="template.image"
                            :src="template.image"
                            :alt="template.name"
                            class="w-14 h-14 rounded-lg border border-dark-border object-cover flex-shrink-0"
                        />

                        <div class="flex-1 min-w-0 space-y-1">
                            <div class="flex items-center justify-between gap-2">
                                <div class="text-sm font-bold text-dark-text truncate">{{ template.name }}</div>
                                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                        class="text-xs px-2 py-1 rounded bg-dark-surface hover:bg-dark-border text-dark-muted hover:text-dark-text"
                                        @click.stop="openEditForm(template)"
                                        title="编辑"
                                    >
                                        ✏️
                                    </button>
                                    <button
                                        class="text-xs px-2 py-1 rounded bg-dark-surface hover:bg-dark-danger/20 text-dark-danger"
                                        @click.stop="emit('delete-template', template.id)"
                                        title="删除"
                                    >
                                        🗑
                                    </button>
                                </div>
                            </div>
                            <p class="text-xs text-dark-muted line-clamp-2">{{ template.subject }}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="totalStylePages > 1" class="flex items-center justify-between gap-2 pt-1">
                <BaseButton variant="secondary" :disabled="stylePage <= 1" @click="stylePage -= 1">上一页</BaseButton>
                <div class="text-xs text-dark-muted font-semibold">第 {{ stylePage }} / {{ totalStylePages }} 页</div>
                <BaseButton variant="secondary" :disabled="stylePage >= totalStylePages" @click="stylePage += 1">下一页</BaseButton>
            </div>

            <BaseInput
                v-if="selectedStyle"
                type="textarea"
                :modelValue="customPrompt"
                @update:modelValue="value => emit('update:customPrompt', value)"
                label="✏️ 特殊要求（选填）"
                placeholder="风格库字段之外，还想额外强调的点，例如：这次要露出品牌 logo..."
                :rows="3"
            />
        </div>

        <div v-else class="flex flex-col gap-3 flex-1 h-full">
            <BaseInput
                type="textarea"
                :modelValue="customPrompt"
                @update:modelValue="updateCustomPrompt"
                label="🍌 描述你的创意想法："
                placeholder="例如：把角色转为写实风格，加入金属质感与高对比灯光..."
                :rows="8"
                class="flex-1 h-full"
            />
            <p class="text-xs text-dark-muted font-medium flex items-center gap-1">💡 描述越详细，结果越可控。</p>
        </div>

        <form v-if="showEditor" class="bg-dark-bg border border-dashed border-dark-border rounded-lg p-4 space-y-3" @submit.prevent="handleSubmit">
            <div class="flex items-center justify-between gap-2">
                <h4 class="font-bold text-dark-text">{{ editorMode === 'create' ? '新增风格档案' : '编辑风格档案' }}</h4>
                <button type="button" class="text-sm text-dark-muted hover:text-dark-text" @click="closeEditor">✖ 关闭</button>
            </div>
            <div class="grid md:grid-cols-2 gap-3">
                <BaseInput
                    label="风格名称"
                    v-model="form.name"
                    required
                />
                <BaseInput
                    label="示例图地址"
                    v-model="form.image"
                    placeholder="/preview.png"
                />
            </div>
            <BaseInput
                type="textarea"
                label="主体特征"
                v-model="form.subject"
                placeholder="人物/产品应该呈现的质感、状态"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                label="环境基调"
                v-model="form.environment"
                placeholder="场景、光线、氛围"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                label="构图规则"
                v-model="form.composition"
                placeholder="镜头角度、景深、取景方式"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                label="色彩分级"
                v-model="form.colorGrading"
                placeholder="整体色调倾向"
                :rows="2"
            />
            <BaseInput
                type="textarea"
                label="禁用项"
                v-model="form.forbidden"
                placeholder="这个风格绝对不能出现的东西"
                :rows="2"
            />
            <p v-if="formError" class="text-sm text-dark-danger font-semibold">{{ formError }}</p>
            <div class="flex items-center gap-2 justify-end">
                <BaseButton type="button" @click="closeEditor" variant="secondary">取消</BaseButton>
                <BaseButton type="submit" variant="primary">保存</BaseButton>
            </div>
        </form>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'
import type { StyleTemplate } from '../types'

const props = defineProps<{
    selectedStyle: string
    customPrompt: string
    templates: StyleTemplate[]
}>()

const emit = defineEmits<{
    'update:selectedStyle': [value: string]
    'update:customPrompt': [value: string]
    'create-template': [value: Omit<StyleTemplate, 'id'>]
    'update-template': [value: StyleTemplate]
    'delete-template': [id: string]
    'export-templates': []
    'import-templates': [fileBase64: string]
}>()

const importInput = ref<HTMLInputElement>()

const handleImportFile = (event: Event) => {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
        if (e.target?.result) {
            emit('import-templates', e.target.result as string)
        }
    }
    reader.readAsDataURL(file)
}

const activeTab = ref<'style' | 'custom'>('style')
const showEditor = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)
const isMobile = ref(false)
const stylePage = ref(1)
const form = reactive({
    name: '',
    subject: '',
    environment: '',
    composition: '',
    colorGrading: '',
    forbidden: '',
    image: ''
})
const formError = ref('')

const stylesPerPage = computed(() => (isMobile.value ? 4 : 6))
const totalStylePages = computed(() => Math.max(1, Math.ceil(props.templates.length / stylesPerPage.value)))
const paginatedTemplates = computed(() => {
    const start = (stylePage.value - 1) * stylesPerPage.value
    return props.templates.slice(start, start + stylesPerPage.value)
})

function refreshIsMobile() {
    if (typeof window === 'undefined') return
    isMobile.value = window.matchMedia('(max-width: 639px)').matches
}

onMounted(() => {
    refreshIsMobile()
    window.addEventListener('resize', refreshIsMobile)
})

onUnmounted(() => {
    window.removeEventListener('resize', refreshIsMobile)
})

watch(
    () => props.templates.length,
    () => {
        stylePage.value = Math.min(stylePage.value, totalStylePages.value)
        if (stylePage.value < 1) stylePage.value = 1
    }
)

const selectStyle = (styleId: string) => {
    if (props.selectedStyle !== styleId) {
        emit('update:customPrompt', '')
    }
    emit('update:selectedStyle', props.selectedStyle === styleId ? '' : styleId)
}

const updateCustomPrompt = (value: string) => {
    // "自定义"标签页下这个字段是完整自定义提示词，跟"选中风格 + 特殊要求"是互斥关系，
    // 一旦用户在这里输入内容，说明这次不走风格库，需要清空已选风格，避免被当成"特殊要求"拼进风格指令。
    if (value && props.selectedStyle) {
        emit('update:selectedStyle', '')
    }
    emit('update:customPrompt', value)
}

const resetForm = () => {
    form.name = ''
    form.subject = ''
    form.environment = ''
    form.composition = ''
    form.colorGrading = ''
    form.forbidden = ''
    form.image = ''
    formError.value = ''
}

const openCreateForm = () => {
    editorMode.value = 'create'
    editingId.value = null
    resetForm()
    showEditor.value = true
}

const openEditForm = (template: StyleTemplate) => {
    editorMode.value = 'edit'
    editingId.value = template.id
    form.name = template.name
    form.subject = template.subject
    form.environment = template.environment
    form.composition = template.composition
    form.colorGrading = template.colorGrading
    form.forbidden = template.forbidden
    form.image = template.image
    showEditor.value = true
}

const closeEditor = () => {
    showEditor.value = false
    editingId.value = null
    resetForm()
}

const handleSubmit = () => {
    formError.value = ''
    if (!form.name.trim()) {
        formError.value = '风格名称不能为空'
        return
    }
    const payload = {
        id: editingId.value || '',
        name: form.name,
        subject: form.subject,
        environment: form.environment,
        composition: form.composition,
        colorGrading: form.colorGrading,
        forbidden: form.forbidden,
        image: form.image
    }
    if (editorMode.value === 'create') {
        const { id, ...rest } = payload
        emit('create-template', rest)
    } else if (editingId.value) {
        emit('update-template', payload as StyleTemplate)
    }
    closeEditor()
}
</script>
