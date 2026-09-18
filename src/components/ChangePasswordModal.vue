<template>
    <transition name="fade">
        <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div class="bg-dark-surface border border-dark-border rounded-2xl max-w-sm w-full shadow-2xl">
                <div class="flex items-center justify-between border-b border-dark-border px-5 py-3">
                    <h3 class="text-lg font-bold text-dark-text flex items-center gap-2">🔒 修改登录密码</h3>
                    <BaseButton @click="handleClose" variant="secondary" class="text-sm py-1 px-3">✖️</BaseButton>
                </div>
                <form class="p-5 space-y-3" @submit.prevent="handleSubmit">
                    <BaseInput
                        type="password"
                        v-model="currentPassword"
                        label="当前密码"
                        required
                    />
                    <BaseInput
                        type="password"
                        v-model="newPassword"
                        label="新密码（至少 6 位）"
                        required
                    />
                    <BaseInput
                        type="password"
                        v-model="confirmPassword"
                        label="确认新密码"
                        required
                    />
                    <p v-if="formError" class="text-sm text-dark-danger font-semibold">{{ formError }}</p>
                    <div class="flex items-center gap-2 justify-end pt-2">
                        <BaseButton type="button" @click="handleClose" variant="secondary">取消</BaseButton>
                        <BaseButton type="submit" variant="primary" :loading="submitting">保存</BaseButton>
                    </div>
                </form>
            </div>
        </div>
    </transition>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import BaseButton from './BaseButton.vue'
import BaseInput from './BaseInput.vue'

const props = defineProps<{
    visible: boolean
    submitting: boolean
}>()

const emit = defineEmits<{
    close: []
    submit: [payload: { currentPassword: string; newPassword: string }]
}>()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const formError = ref('')

watch(
    () => props.visible,
    visible => {
        if (visible) {
            currentPassword.value = ''
            newPassword.value = ''
            confirmPassword.value = ''
            formError.value = ''
        }
    }
)

const handleSubmit = () => {
    formError.value = ''
    if (newPassword.value.length < 6) {
        formError.value = '新密码至少需要 6 位'
        return
    }
    if (newPassword.value !== confirmPassword.value) {
        formError.value = '两次输入的新密码不一致'
        return
    }
    emit('submit', { currentPassword: currentPassword.value, newPassword: newPassword.value })
}

const handleClose = () => {
    emit('close')
}
</script>
