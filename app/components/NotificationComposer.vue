<script setup lang="ts">
const emit = defineEmits<{
  send: [message: string]
  cancel: []
}>()

const message = ref('')

function submit() {
  const value = message.value.trim()
  if (!value) return

  emit('send', value)
  message.value = ''
}
</script>

<template>
  <div class="space-y-4">
    <textarea
      v-model="message"
      class="input-field min-h-28 resize-y text-sm"
      placeholder="Escribe un mensaje..."
      maxlength="500"
    />
    <div class="flex justify-end gap-3">
      <button class="btn-secondary text-sm" @click="emit('cancel')">Cancelar</button>
      <button class="btn-primary text-sm" :disabled="!message.trim()" @click="submit">
        Enviar
      </button>
    </div>
  </div>
</template>
