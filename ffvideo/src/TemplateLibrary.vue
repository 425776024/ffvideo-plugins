<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { api } from './runtime';
import Icon from './Icon.vue';
type Scene = { heading: string; body: string; seconds?: number; visualPrompt?: string; visualQuery?: string };
type Recipe = { title: string; narration: string; scenes: Scene[]; tags: string[]; language: string; visualTheme?: string; visualStyle?: string };
type Template = { id: string; name: string; category: string; description: string; mediaKinds?: string[]; useCases: string[]; fields: { key: string; label: string; required: boolean; example: string; maxLength?: number }[]; structure: { heading: string; purpose: string; seconds: number }[]; example?: { topic: string; values: Record<string,string>; recipe: Recipe } };
const props = defineProps<{ selectedId: string; workId?: string }>();
const emit = defineEmits<{ close: []; select: [id: string]; generate: [topic: string, id: string]; created: [result: { feedId: string; jobId: string }] }>();
const templates = shallowRef<Template[]>([]);
const selected = shallowRef<Template>();
const category = ref('全部');
const values = ref<Record<string,string>>({});
const preview = ref<Recipe>();
const original = shallowRef<Recipe>();
const copiedTopic = ref('');
const editing = ref(false);
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const categories = computed(() => ['全部', ...new Set(templates.value.map(t => t.category))]);
const visible = computed(() => templates.value.filter(t => category.value === '全部' || t.category === category.value));
const missing = computed(() => selected.value?.fields.filter(f => f.required && !values.value[f.key]?.trim()) || []);
const mediaLabel = (kind: string) => ({ photo: '照片', png: 'PNG', svg: 'SVG', canvas: 'Canvas', markdown: 'Markdown', lottie: 'Lottie', video: '实录', native: '原生动画' }[kind] || kind);
let loadSequence = 0, contentRevision = 0;
watch(values, () => { contentRevision++; preview.value = undefined; original.value = undefined; editing.value = false; }, { deep: true, flush: 'sync' });
async function choose(id: string) {
  const sequence = ++loadSequence;
  error.value = ''; preview.value = undefined; original.value = undefined; editing.value = false;
  try {
    const result = await api<Template>(`/templates/${encodeURIComponent(id)}`);
    if (sequence !== loadSequence) return;
    selected.value = result; values.value = {};
  } catch (e) { if (sequence === loadSequence) error.value = String((e as Error).message); }
}
async function compile() {
  if (!selected.value) return;
  const revision = contentRevision, id = selected.value.id, submittedValues = { ...values.value };
  const result = await api<{ recipe: Recipe | null; missingFields: { label: string }[] }>('/templates/instantiate', { method: 'POST', body: JSON.stringify({ templateId: id, values: submittedValues }) });
  if (revision !== contentRevision || selected.value?.id !== id) return;
  if (!result.recipe) throw new Error('请填写：' + result.missingFields.map(f => f.label).join('、'));
  original.value = structuredClone(result.recipe); preview.value = result.recipe; editing.value = true;
}
async function example() {
  if (!selected.value?.example) return;
  values.value = { ...selected.value.example.values };
  await compile();
}
async function showScenes() { try { error.value = ''; await compile(); } catch (e) { error.value = String((e as Error).message); } }
function patches() {
  if (!preview.value || !original.value) return {};
  const changes: any = {};
  if (preview.value.title !== original.value.title) changes.title = preview.value.title;
  if (preview.value.narration !== original.value.narration) changes.narration = preview.value.narration;
  const scenes = preview.value.scenes.flatMap((scene, index) => {
    const before = original.value!.scenes[index];
    const patch: any = { index };
    for (const key of ['heading', 'body', 'visualPrompt', 'visualQuery', 'seconds'] as const) if (scene[key] !== before[key]) patch[key] = scene[key];
    return Object.keys(patch).length > 1 ? [patch] : [];
  });
  if (scenes.length) changes.scenes = scenes;
  return changes;
}
async function create() {
  if (busy.value) return; busy.value = true; error.value = '';
  try {
    let result;
    if (props.workId) result = await api<{ feedId: string; jobId: string }>(`/works/${encodeURIComponent(props.workId)}/reuse`, { method: 'POST', body: JSON.stringify({ topic: copiedTopic.value, overrides: patches() }) });
    else {
      if (!selected.value) return;
      result = await api<{ feedId: string; jobId: string }>('/templates/drafts', { method: 'POST', body: JSON.stringify({ templateId: selected.value.id, values: values.value, overrides: patches() }) });
    }
    emit('created', result);
  } catch (e) { error.value = String((e as Error).message); } finally { busy.value = false; }
}
onBeforeUnmount(() => { loadSequence++; contentRevision++; });
onMounted(async () => {
  try {
    if (props.workId) {
      const result = await api<{ work: { topic: string }; recipe: Recipe }>(`/works/${encodeURIComponent(props.workId)}/recipe`);
      copiedTopic.value = result.work.topic; original.value = structuredClone(result.recipe); preview.value = result.recipe; editing.value = true;
    } else templates.value = (await api<{ templates: Template[] }>('/templates')).templates;
  } catch (e) { error.value = String((e as Error).message); } finally { loading.value = false; }
});
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="template-modal" role="dialog" aria-modal="true" aria-labelledby="template-heading">
      <header class="modal-heading">
        <button v-if="selected && !workId" class="icon-button" aria-label="返回模板列表" @click="selected = undefined; editing = false"><Icon name="back" /></button>
        <h2 id="template-heading">{{ workId ? '复制作品' : selected?.name || '草稿模板' }}</h2>
        <button class="icon-button" aria-label="关闭模板" @click="emit('close')"><Icon name="close" /></button>
      </header>
      <div class="template-body">
        <p v-if="loading">正在加载…</p>
        <template v-else-if="!selected && !workId">
          <button class="text-button" @click="emit('select', 'auto')">自动匹配场景</button>
          <div class="template-filters"><button v-for="item in categories" :key="item" :class="{ selected: item === category }" @click="category = item">{{ item }}</button></div>
          <div class="template-grid"><button v-for="item in visible" :key="item.id" class="template-card" :class="{ chosen: item.id === selectedId }" @click="choose(item.id)">
            <span class="template-category">{{ item.category }}</span><strong>{{ item.name }}</strong><p>{{ item.description }}</p><span class="template-media">{{ (item.mediaKinds || []).map(mediaLabel).join(' · ') }}</span>
          </button></div>
        </template>
        <template v-else>
          <template v-if="selected">
            <p class="template-description">{{ selected.description }}</p>
            <p class="template-uses">{{ selected.useCases.join(' / ') }}</p>
            <div class="template-actions"><button class="secondary-button" @click="example">复制示例</button><button class="text-button" @click="emit('select', selected.id)">设为生成模板</button></div>
            <form class="template-fields" @submit.prevent="showScenes">
              <label v-for="field in selected.fields" :key="field.key" class="field-label">{{ field.label }}{{ field.required ? ' *' : '' }}
                <input v-if="field.key === 'topic'" v-model="values[field.key]" :placeholder="field.example" :maxlength="field.maxLength || 80" />
                <textarea v-else v-model="values[field.key]" :placeholder="field.example" :maxlength="field.maxLength || 800" rows="2" />
              </label>
              <button class="secondary-button" :disabled="missing.length > 0">查看分镜并局部修改</button>
            </form>
          </template>
          <label v-else class="field-label">话题<input v-model="copiedTopic" maxlength="120" /></label>
          <div v-if="editing && preview" class="template-scenes">
            <label class="field-label">作品标题<input v-model="preview.title" maxlength="160" /></label>
            <details v-for="(scene, index) in preview.scenes" :key="index" :open="index === 0"><summary>{{ index + 1 }} · {{ scene.heading }}</summary>
              <label class="field-label">画面标题<input v-model="scene.heading" maxlength="160" /></label>
              <label class="field-label">这一幕的旁白<textarea v-model="scene.body" maxlength="800" rows="3" /></label>
              <label class="field-label">画面描述<textarea v-model="scene.visualPrompt" maxlength="1200" rows="2" /></label>
              <label class="field-label">图片搜索词<input v-model="scene.visualQuery" maxlength="160" /></label>
            </details>
            <details><summary>完整旁白</summary><label class="field-label">留原文时，修改分镜会自动更新旁白<textarea v-model="preview.narration" maxlength="5000" rows="5" /></label></details>
          </div>
        </template>
        <p v-if="error" class="template-error" role="alert">{{ error }}</p>
      </div>
      <footer v-if="selected || workId" class="template-footer">
        <button v-if="selected" class="secondary-button" :disabled="!values.topic?.trim() || busy" @click="emit('generate', values.topic, selected.id)">按话题生成 5 条</button>
        <button class="primary-button" :disabled="busy || (selected ? missing.length > 0 : !preview)" @click="create">{{ busy ? '提交中' : '制作这份草稿' }}</button>
      </footer>
    </section>
  </div>
</template>
<style scoped>
.template-modal{width:min(640px,100%);max-height:90dvh;background:#17191e;border:1px solid #30333b;border-radius:18px;display:flex;flex-direction:column;overflow:hidden}.modal-heading{gap:10px;padding:18px}.modal-heading h2{font-size:19px;flex:1;margin:0}.template-body{padding:0 20px 20px;overflow:auto;overscroll-behavior:contain}.template-filters{display:flex;gap:8px;overflow:auto;padding:3px 0 14px}.template-filters button{white-space:nowrap;background:#252830;border:0;border-radius:20px;color:#aaaeb9;padding:7px 12px;font-size:12px}.template-filters .selected{background:#9cf4d8;color:#153027}.template-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.template-card{background:#20232a;border:1px solid #333740;border-radius:13px;padding:16px;text-align:left;color:#f5f5f7}.template-card.chosen{border-color:#9cf4d8}.template-category{color:#9cf4d8;font-size:11px}.template-card strong{display:block;margin:7px 0;font-size:15px}.template-card p{margin:0;font-size:12px;line-height:1.65;color:#a9adba}.template-media{display:block;color:#7e8490;font-size:10px;margin-top:12px}.template-description{font-size:14px;line-height:1.7}.template-uses{color:#949aa7;font-size:12px}.template-actions{display:flex;gap:12px;align-items:center;margin:14px 0}.template-fields,.template-scenes{display:grid;gap:12px}.template-scenes{margin-top:18px}.template-scenes details{border:1px solid #343842;border-radius:10px;padding:12px}.template-scenes summary{cursor:pointer;font-size:13px}.template-scenes details[open] .field-label{margin-top:12px}.template-footer{padding:14px 20px;border-top:1px solid #30343e;display:flex;gap:10px;justify-content:flex-end}.primary-button{background:#9cf4d8;border:0;border-radius:8px;color:#11382c;font-weight:600;padding:10px 14px}.template-error{color:#ffaaa2;font-size:13px}.field-label textarea{resize:vertical;width:100%;background:#22252d;color:#eee;border:1px solid #393e4a;border-radius:8px;padding:10px;font:inherit;box-sizing:border-box}.template-fields .field-label{font-size:12px}button:disabled{opacity:.45;cursor:default}@media(max-width:440px){.template-modal{max-height:95dvh;border-radius:14px}.template-grid{gap:8px}.template-card{padding:12px}.template-body{padding:0 14px 14px}.template-footer{padding:12px;flex-wrap:wrap}}
</style>
