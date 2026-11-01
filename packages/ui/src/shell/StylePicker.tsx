import { useEffect, useRef, useState } from 'react';
import type { StyleProfile, StyleProfileSummary } from '../../../writing-core/src/style-profile.js';
import type { StyleSelectionInput, StyleSelectionSnapshot } from '../../../writing-core/src/style-package.js';
import type { StyleLibraryHost } from './StyleLibraryDialog.tsx';
import css from './StylePicker.module.css';

const key = (value: { id: string; version: number }) => `${value.id}@${value.version}`;
export function StylePicker({ host, projectId, disabled, onChange, onManage, refreshKey, requested, onRequestedApplied, onBusyChange }: {
  host: StyleLibraryHost; projectId: string; disabled: boolean; onChange: (value: StyleSelectionInput | undefined) => void;
  onManage: () => void; refreshKey?: boolean | string | undefined; requested?: StyleProfile | undefined; onRequestedApplied?: (() => void) | undefined;
  onBusyChange?: (value: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<readonly StyleProfileSummary[]>([]);
  const [selected, setSelected] = useState<Pick<StyleSelectionSnapshot, 'id' | 'version' | 'name'> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const previousProject = useRef(projectId);
  const applying = useRef(false);
  const requestedRef = useRef(onRequestedApplied); requestedRef.current = onRequestedApplied;
  const consumedRequest = useRef<StyleProfile | undefined>(undefined);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const turn = ++generation.current;
    if (previousProject.current !== projectId) { setSelected(null); changeRef.current(undefined); previousProject.current = projectId; }
    setBusy(true); setError('');
    void host.styleLibrary?.(projectId ? { action: 'selection', projectId } : { action: 'list' }).then(result => {
      if (generation.current !== turn) return;
      setProfiles(result.profiles);
      if (projectId) setSelected(result.selection ?? null);
    }).catch(reason => { if (generation.current === turn) setError(reason instanceof Error ? reason.message : '风格列表加载失败，请重试。'); })
      .finally(() => { if (generation.current === turn) setBusy(false); });
    return () => { generation.current++; };
  }, [host, projectId, refreshKey, reload]);
  const choose = async (choice: Pick<StyleProfileSummary, 'id' | 'version' | 'name'> | null) => {
    if (applying.current || disabled) return;
    applying.current = true; setBusy(true); setError('');
    const target = projectId, turn = generation.current;
    const selection = choice ? { id: choice.id, version: choice.version } : null;
    try {
      if (target) await host.styleLibrary?.({ action: 'select', projectId: target, selection });
      if (currentProject.current !== target || turn !== generation.current) return;
      setSelected(choice);
      changeRef.current(target ? undefined : selection);
    } catch (reason) {
      if (currentProject.current === target && generation.current === turn) setError(reason instanceof Error ? reason.message : '未能保存风格选择，请重试。');
    } finally { applying.current = false; if (currentProject.current === target && generation.current === turn) setBusy(false); }
  };
  useEffect(() => {
    if (!requested) { consumedRequest.current = undefined; return; }
    if (busy || disabled || consumedRequest.current === requested) return;
    consumedRequest.current = requested;
    void choose(requested).finally(() => requestedRef.current?.());
  }, [requested, busy, disabled]);
  const missing = selected && !profiles.some(profile => key(profile) === key(selected));
  return <div className={css.picker}>
    <label>写作风格 <select aria-label="写作风格" value={selected ? key(selected) : ''} disabled={busy || disabled} onChange={event => {
      if (event.target.value === '__manage__') { onManage(); return; }
      const choice = profiles.find(profile => key(profile) === event.target.value);
      if (choice || !event.target.value) void choose(choice ?? null);
    }}>
      <option value="">{busy ? '正在加载…' : '不指定风格'}</option>
      {missing && <option value={key(selected)}>{selected.name}（本项目保存版本）</option>}
      {profiles.map(profile => <option key={key(profile)} value={key(profile)}>{profile.name}</option>)}
      <option value="__manage__">管理风格库…</option>
    </select></label>
    {error && <span role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>刷新列表</button></span>}
    {!!projectId && selected && <span className={css.hint}>已保存 · 用于后续写作</span>}
  </div>;
}
