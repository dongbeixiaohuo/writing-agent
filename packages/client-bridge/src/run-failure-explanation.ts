import type { DiagnosticOperationStatus, RunDiagnosticTraceStep } from './protocol.js'

export interface RunFailureExplanation {
  title: string
  detail: string
  remediation: string
}

export interface RunFailureContext {
  kind: RunDiagnosticTraceStep['kind']
  status: DiagnosticOperationStatus
  technicalName?: string | undefined
  errorCode: string | null
  transportPhase?: 'first_response' | 'stream_idle' | undefined
  httpStatus?: number | undefined
}

/**
 * Explains only the boundary established by persisted trace fields. It must not
 * infer a provider outage, bad model output, or unreachable website from a
 * generic failure code.
 */
export function explainRunFailure(context: RunFailureContext): RunFailureExplanation {
  const { errorCode: code, technicalName, transportPhase } = context
  if (code === 'FACT_EXTERNAL_RECORD_REQUIRED') return {
    title: '核查提交的查证依据不完整',
    detail: '模型声称已外部查证，但提交的来源未对应本轮成功搜索或读取记录；这不是模型无响应或搜索超时。',
    remediation: '修正对应来源记录，或如实改用材料对照/模型复核，不需要为了补引用重复搜索。真实未决问题应说明纠正动作。稿件仍保留。',
  }
  if (code === 'FACT_CLAIM_SELECTION_REQUIRED') return {
    title: '新增待查事实没有说明选择原因',
    detail: '模型增加了待查条目，但没有记录为什么需要核对；这是提交格式问题，不是模型无响应或搜索故障。',
    remediation: '为新增条目补充key_fact或suspected_error，保留原待查条目后重新提交，不必重新读取全文。',
  }
  if (code === 'FACT_KEY_EXTERNAL_CHECK_REQUIRED') return {
    title: '旧核查规则拒绝了提交',
    detail: '这条历史记录来自要求关键事实逐条外部查证的旧规则；当前版本已取消该要求。',
    remediation: '在当前版本重新核查即可；无需为普通背景或作者自述补充公开证明。稿件仍保留。',
  }
  if (code === 'CHECKPOINT_REWORK_REQUIRED' || code === 'OUTLINE_REWORK_REQUIRED') return {
    title: '当前决策记录要求先修改，不能直接进入下一阶段',
    detail: '模型已返回调度请求，但程序读到的作者决策是“修改当前阶段”，因此拒绝跳步；这不是模型无响应，也不是搜索故障。决策记录可能与作者本意不符，需要核对本轮回复。',
    remediation: '如果你已认可当前成果，回到对话点击“认可当前阶段，继续”重新明确确认；如果仍要修改，说明修改要求，改好后再确认。无需重新提交材料。',
  }
  if (context.kind === 'model') {
    if (transportPhase === 'first_response') return {
      title: '模型未在等待时限内返回首个有效内容',
      detail: '失败发生在模型请求阶段；本机记录的是首次有效响应等待超时，未获得可交给后续步骤的模型结果。',
      remediation: '请稍后重试这一步，已保存内容仍在。若反复超时，再查看“时序”并验证模型连接。',
    }
    if (transportPhase === 'stream_idle') return {
      title: '模型响应在传输中停滞',
      detail: '失败发生在模型请求阶段；本机曾收到响应活动，但后续内容超过本地等待时限。',
      remediation: '请稍后重试这一步，已保存内容仍在。若反复停滞，再查看“时序”的最后内容时间并验证模型连接。',
    }
    if (code === 'MODEL_OUTPUT_TRUNCATED') return {
      title: '模型输出未完整结束',
      detail: '失败发生在模型输出阶段；已记录的结果不足以完成本次步骤。',
      remediation: '查看输出与时序详情，必要时缩小单次任务或提高可用输出上限后重试。',
    }
    if (code === 'MODEL_RESPONSE_INVALID') return {
      title: '模型回复未通过格式校验',
      detail: '模型请求已有返回，但回复不符合本步骤要求的格式。该结果没有作为正式成果保存。',
      remediation: '查看本步骤的输出与技术代码，核对服务类型和模型兼容性后重试；无需重新填写写作材料。',
    }
    if (context.status === 'outcome_unknown') return {
      title: '模型请求结果尚未确认',
      detail: '客户端已停止等待，现有记录无法确认服务端最终结果。',
      remediation: '先检查时序和模型配置；确认本次没有产生可用结果后再重试。',
    }
    return {
      title: '模型请求未成功完成',
      detail: '失败发生在模型请求阶段；现有代码不足以判定更具体的外部原因。',
      remediation: '查看本步骤的输出与时序，核对模型配置、账户状态和连接后再重试。',
    }
  }

  if (technicalName === 'submit_writing_stage' && (code?.startsWith('STAGE_') || code?.startsWith('WORKFLOW_'))) return {
    title: '写作阶段提交未通过程序校验',
    detail: '失败发生在本机保存或流程前置条件校验。已保存的上一版成果仍可查看。',
    remediation: '查看本步骤的技术代码与输出，按具体校验原因修正当前阶段后重试。',
  }

  if (code === 'FACT_SEARCH_DISABLED') return {
    title: '外部事实搜索已关闭',
    detail: '当前运行配置不允许调用外部事实搜索；本次未请求搜索服务。',
    remediation: '保持模型复核模式并明确披露未联网验证，或在需要联网核查时先启用搜索。',
  }

  if (technicalName === 'read_author_web') {
    if (code === 'WEB_ARTICLE_ACCESS_RESTRICTED') return {
      title: '微信返回了验证或访问受限页',
      detail: '网页请求已执行，但没有取得可确认的文章正文；不是模型未响应，也不是搜索引擎出错。',
      remediation: '请在浏览器或微信中确认文章能否打开；也可以粘贴正文作为材料。不会自动绕过登录或安全验证。',
    }
    if (code === 'WEB_ARTICLE_UNAVAILABLE') return {
      title: '微信文章已不可用',
      detail: '来源页面提示内容已删除、违规或无法查看，未保存为可用材料。',
      remediation: '提供仍可访问的文章链接，或提供你已取得的正文。',
    }
    if (code === 'WEB_ARTICLE_CONTENT_MISSING' || code === 'AUTHOR_WEB_CONTENT_EMPTY') return {
      title: '网页没有返回可读取的正文',
      detail: '网页获取结束，但未能提取文章内容；不会把菜单或提示页当成文章。',
      remediation: '核对是否为文章详情链接，或粘贴正文；图文中的图片文字暂不做 OCR。',
    }
    if (code === 'AUTHOR_WEB_LIMIT_REACHED') return {
      title: '本轮网页读取次数已达上限',
      detail: '每轮最多读取 3 次外部网页；本次未再请求网站。',
      remediation: '先使用已保存材料，其他链接可以下一轮继续读取。',
    }
    if (code === 'ABORTED' || code === 'WEB_REQUEST_ABORTED') return {
      title: code === 'ABORTED' ? '网页读取已停止' : '网页读取超时或被取消',
      detail: '本次没有取得并保存完整文章；不是搜索引擎失败。',
      remediation: '需要时重新读取该链接，或粘贴正文；单次外部读取最长等待 15 秒。',
    }
    return {
      title: '用户提供的网页读取失败',
      detail: '失败发生在直接网页读取或材料保存阶段；未确认正文可用，不能推断为模型故障或搜索服务故障。',
      remediation: '查看技术代码和输出详情，核对链接是否为可公开访问的 HTTP(S) 文章；也可以直接粘贴正文。',
    }
  }

  if (technicalName === 'search_fact_sources') {
    if (code === 'SEARCH_LIMIT_REACHED') return {
      title: '本轮公开搜索次数已达上限',
      detail: '这是本轮检索次数门禁；本次未发起新的搜索服务请求。',
      remediation: '使用本轮已有搜索结果完成核查，不要重复搜索；未证实的主张应保持不确定标记。',
    }
    if (code === 'SEARCH_APPROVAL_TIMEOUT' || code === 'SEARCH_APPROVAL_FAILED' || code === 'SEARCH_NOT_AUTHORIZED') return {
      title: '公开搜索尚未执行',
      detail: '失败发生在外发检索授权阶段；记录表明尚未请求搜索服务。',
      remediation: '确认脱敏检索词并完成搜索授权，再重试本次检索。',
    }
    return {
      title: '公开搜索服务请求失败',
      detail: '失败发生在公开搜索工具阶段；现有记录不表示模型未响应，也不足以推断更具体的外部原因。',
      remediation: '查看该步骤的搜索进度与输出，在搜索设置中检查对应服务连接后再重试。',
    }
  }

  if (technicalName === 'read_fact_source') {
    if (code === 'FACT_SOURCE_NOT_IN_LEDGER') return {
      title: '来源读取被授权记录门禁拒绝',
      detail: '当前读取目标未匹配到证据账本或本轮搜索的可用来源记录；门禁在未发出网络读取时已拒绝。',
      remediation: '先运行公开搜索并使用本轮返回或账本已有的同一来源；若已有记录，再核对 URL 形式是否一致。',
    }
    if (code === 'FACT_SOURCE_TIMEOUT') return {
      title: '已授权来源原文读取超时',
      detail: '失败发生在来源原文读取阶段；本次没有取得可确认的原文内容。',
      remediation: '使用已取得的搜索摘录并明确标注未核对原文，或改用其他已授权来源。',
    }
    if (code === 'NETWORK_PRIVATE_TARGET_DENIED' || code === 'NETWORK_CREDENTIALS_DENIED') return {
      title: '来源读取被本机安全规则拒绝',
      detail: code === 'NETWORK_PRIVATE_TARGET_DENIED'
        ? '目标被本机网络安全规则判定为不允许访问的私有网络地址；对该目标未发出网络读取。若发生重定向，先前公开地址可能已被读取。'
        : '来源地址包含本机安全规则不允许携带的凭据信息；对该目标未发出网络读取。若发生重定向，先前公开地址可能已被读取。',
      remediation: '使用不含凭据、且符合公开网络访问规则的已授权来源；不要放宽本机安全边界。',
    }
    if (code === 'NETWORK_TARGET_UNRESOLVED') return {
      title: '来源域名解析失败',
      detail: '本机未能将目标域名解析为可用网络地址；本次未取得网页内容。',
      remediation: '核对来源域名与本机 DNS 状态，或改用其他已授权的公开来源。',
    }
    if (code === 'WEB_HTTP_STATUS_REJECTED') {
      const status = context.httpStatus;
      const known = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
      const meaning = status === 401 ? '网站要求身份验证' : status === 403 ? '网站拒绝访问' : status === 404 ? '页面不存在'
        : status === 429 ? '网站限制请求频率' : known && status >= 500 ? '网站服务异常' : '网站未返回成功响应';
      return {
        title: known ? `来源网站返回 HTTP ${status}：${meaning}` : '来源网站未返回成功响应（旧记录缺少状态码）',
        detail: `${known ? '请求已到达来源网站，但没有取得可确认的原文。' : '旧记录未保存具体 HTTP 状态，不能推断为 403、404 或其他原因。'}这不是禁止 http:// 来源，也不表示模型或搜索引擎失败。`,
        remediation: '使用已有搜索摘录并注明未读取原文，或换一个公开来源；不要反复重试同一页面。',
      }
    }
    return {
      title: '已授权来源原文读取失败',
      detail: '失败发生在来源读取工具阶段；现有记录不足以说明网站宕机或搜索服务失败。',
      remediation: '查看该步骤输出，使用已有搜索摘录并说明限制，或选择其他已授权来源。',
    }
  }

  if (technicalName === 'submit_fact_check' || code?.startsWith('FACT_CHECK_') || code?.startsWith('FACT_GATE_')) return {
    title: '事实核查提交被业务门禁拒绝',
    detail: '失败发生在事实核查提交或校验阶段；这不是模型无响应或搜索服务失败的证据。',
    remediation: '根据技术代码检查主张、证据引用、当前正文与标题绑定，修正后重新提交核查。',
  }

  if (context.status === 'outcome_unknown') return {
    title: '工具外部结果尚未确认',
    detail: '请求已发出，但当前记录无法确认外部操作的最终结果。',
    remediation: '先到目标系统核对实际结果，未确认前不要盲目重试可能产生副作用的操作。',
  }

  return {
    title: context.kind === 'agent' ? 'Agent 调度未成功完成' : '工具执行失败',
    detail: '现有记录只能确认该步骤未成功完成，不足以推断其他系统的状态。',
    remediation: '查看本步骤的输入与输出详情，按技术代码修正前置条件后再重试。',
  }
}
