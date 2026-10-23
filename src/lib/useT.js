import { useStore } from '../store'
import { translate } from './i18n'

/** 组件里取翻译函数：const t = useT(); t('topbar.newTask') */
export function useT() {
  const language = useStore((s) => s.language)
  return (key, vars) => translate(language, key, vars)
}
