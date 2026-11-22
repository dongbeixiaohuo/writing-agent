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
  if (context.kind !== 'model' && context.status === 'outcome_unknown') return {
    title: '还不知道这一步有没有完成',
    detail: 'App 已经发出请求，但没收到能确认结果的回执。',
    remediation: '先回到对话或查看稿件，确认有没有新结果。确认没有结果后再决定是否重试。',
  }
  if (code === 'MODEL_GROUP_UNAVAILABLE') return {
    title: '这一步选用的模型暂时不能用',
    detail: '给这一步指定的模型需要重新验证。',
    remediation: '在模型设置里测试这个模型，或为这一步选择一个已经验证的模型，再回到对话继续。',
  }
  if (code === 'TOOL_NO_PROGRESS') return {
    title: '助手反复读了同一份内容',
    detail: '连续读取没有得到新内容，App 暂停了这一步。已保存的内容还在。',
    remediation: '回到对话重试这一步，可以继续用已有材料。',
  }
  if (code === 'PARAGRAPH_EDITS_INVALID' || code === 'REVIEW_EDITS_INVALID' || code === 'FINAL_LINT_INVALID') return {
    title: '这次段落修改未保存',
    detail: '提交的改动与当前稿件或允许修改的段落不匹配。已保存的正文和标题仍可查看。',
    remediation: '回到对话重试这一步，让主笔按当前稿件重新定位修改。也可以在「稿件与版本」中查看当前正文。',
  }
  if (code === 'PROVIDER_RETRY_DEFERRED') return {
    title: '模型服务要求稍后再试',
    detail: '这一步已暂停，已保存的进度还在。',
    remediation: '到对话里查看建议的重试时间，也可以换用已经验证的模型。',
  }
  if (code === 'SEARCH_QUERY_TOO_LONG') return {
    title: '搜索词太长，这次没有搜索',
    detail: '当前搜索服务最多接受 128 个字符。',
    remediation: '回到对话，让助手把搜索词缩短后再搜。',
  }
  if (code === 'INTAKE_SOURCE_READ_REQUIRED') return {
    title: '方案还没保存，你给的链接还没读完',
    detail: '助手准备提交方案，但有链接还没尝试打开。',
    remediation: '回到对话，让助手先读这些链接。打不开的网页也可以直接贴正文。',
  }
  if (code === 'INTAKE_DIRECTION_OPTIONS_REQUIRED' || code === 'INTAKE_DIRECTION_OPTIONS_INVALID') return {
    title: '助手还没有给出完整的方向列表',
    detail: '这条回复需要先补齐可选方向，才能交给你选择。',
    remediation: '如果对话停在这里，可以重试这一步，让助手列出可选方向。',
  }
  if (code === 'AUTHOR_OUTPUT_REQUIRED' || code === 'INTAKE_PROPOSAL_REQUIRED' || code === 'STAGE_OUTPUT_NOT_SAVED') return {
    title: '助手回了话，但这一步还没做完',
    detail: '这一步应该提交的成果没有保存。',
    remediation: '回到对话重试当前一步。已经保存的稿件仍可在「稿件与版本」里查看。',
  }
  if (code?.startsWith('INTAKE_') && code.includes('AUTHORIZATION')) return {
    title: '这一步还不能按该要求继续',
    detail: 'App 没找到能确认这一要求的作者原话。',
    remediation: '回到对话，直接说明你的要求，再让助手继续。',
  }
  if (code === 'TOOL_PERMISSION_DENIED') return {
    title: '这一步暂时不能进行',
    detail: '助手这次没有执行该操作的权限。',
    remediation: '回到对话看助手有没有继续。若停在这里，可以查看当前步骤说明或重试。',
  }
  if (code === 'TOOL_INPUT_INVALID' || code === 'TOOL_ARGUMENTS_INVALID') return {
    title: '这一步缺了需要的信息',
    detail: '助手传给这一步的内容不完整，或写法不符合这一步的要求。',
    remediation: '如果助手停在这里，重试这一步即可继续使用之前的输入。',
  }
  if (code === 'MATERIAL_NOT_FOUND' || code === 'ARTIFACT_VERSION_NOT_FOUND') return {
    title: '没找到要读取的材料或稿件',
    detail: '这次想打开的内容没有读到。',
    remediation: '检查项目里是否还保留这份材料或稿件版本，也可以让助手使用当前版本。',
  }
  if (code === 'READER_RETEST_STALE') return {
    title: '读者试读期间，稿件改了',
    detail: '这次试读针对的是旧版，读后感没有保存到当前稿件。',
    remediation: '如果还想看读者反应，可以对当前稿件再试读一次。',
  }
  if (code === 'WRITING_READINESS_REQUIRED' || code === 'WRITING_READINESS_INVALID' || code === 'READINESS_CONTEXT_READ_REQUIRED') return {
    title: '这一步还没准备好',
    detail: '助手还没有完成继续写作前要做的检查。',
    remediation: '回到对话看是否需要你补充信息。如果已经给过，可以重试这一步。',
  }
  if (code?.startsWith('DIRECTOR_') || code === 'INTENT_SELECTION_INVALID') return {
    title: '助手没能接上当前工作',
    detail: '这次安排与当前写作进度或作者的选择对不上。',
    remediation: '回到对话查看现在停在哪一步，再重试或告诉助手要接着做什么。',
  }
  if (code === 'BODY_STAGE_CONTAINS_PROCESS_NOTES' || code === 'BODY_STAGE_STRUCTURE_MISMATCH') return {
    title: '这次正文没有保存',
    detail: code === 'BODY_STAGE_CONTAINS_PROCESS_NOTES'
      ? '助手把写作过程里的备注写进了正文。' : '这次交回的正文和这一轮要求的改动范围对不上。',
    remediation: '在对话里重试这一步，让助手按原要求交回正文。',
  }
  if (code === 'EVIDENCE_LEDGER_INVALID' || code === 'EDITORIAL_PLAN_INVALID' || code === 'PREWRITING_INVALID') return {
    title: '资料或写作安排没有保存',
    detail: '助手交回的资料或安排有缺项，App 还不能交给下一步。',
    remediation: '回到对话重试这一步，继续用你已经提供的材料。',
  }
  if (code === 'FACT_CLAIM_NOT_IN_ARTICLE' || code === 'FACT_SUBMISSION_INCOMPLETE') return {
    title: '核查没有对上当前稿件',
    detail: code === 'FACT_CLAIM_NOT_IN_ARTICLE'
      ? '这次要查的那句话，在当前稿件里找不到。' : '这次还有已经列出的疑点没有核对。',
    remediation: '回到对话，让助手按当前稿件把核查补齐。',
  }
  if (code === 'FACT_EXTERNAL_RECORD_REQUIRED') return {
    title: '核查提交的查证依据不完整',
    detail: '核查结果里提到的部分资料，在这次保存的来源里找不到。稿件仍保留。',
    remediation: '回到对话，让助手先用已经找到的材料核对。暂时查不清的地方可以留待确认。',
  }
  if (code === 'FACT_CLAIM_SELECTION_REQUIRED') return {
    title: '助手没说清为什么要查这一处',
    detail: '这一步新增了要查的事实，漏写了理由，所以核查结果没能保存。',
    remediation: '回到对话重试核查，让助手补上理由，继续用已有的稿件和材料。',
  }
  if (code === 'FACT_KEY_EXTERNAL_CHECK_REQUIRED') return {
    title: '旧版因为缺少公开资料停下了核查',
    detail: '这是旧版要求每条重要事实都要找公开资料时留下的记录。新版已取消这项要求。',
    remediation: '用当前版本重新核查即可，无需为普通背景或作者自述逐条找公开证明。',
  }
  if (code === 'CHECKPOINT_REWORK_REQUIRED' || code === 'OUTLINE_REWORK_REQUIRED') return {
    title: '当前这一步还需要修改',
    detail: 'App 把你上一条回复理解成了「先改这一步」，所以停在这里。',
    remediation: '如果这版已经可以，在对话里点「认可当前阶段，继续」。还想调整的话，直接告诉助手怎么改。',
  }
  if (context.kind === 'model') {
    if (code === 'PARALLEL_TASK_TIMEOUT') return {
      title: '这位模拟读者迟迟没有回完',
      detail: '这位读者的回复没能保存，其他读者可以继续。',
      remediation: '如果所有读者都没有返回，可以稍后再试读。',
    }
    if (code === 'PARALLEL_TEXT_INVALID') return {
      title: '这位模拟读者没有给出可用的读后感',
      detail: '这位读者的结果被略过，其他读者可以继续。',
      remediation: '如果所有读者都没有返回，可以稍后再试读。',
    }
    if (transportPhase === 'first_response') return {
      title: '等了很久，模型还没开始回复',
      detail: '这一步等到超时，已保存的内容还在。',
      remediation: '可以稍后重试。多次出现时，到模型设置里测试连接。',
    }
    if (transportPhase === 'stream_idle') return {
      title: '模型回复到一半停了',
      detail: 'App 等不到后面的内容，这次回复没有完成。',
      remediation: '可以稍后重试。这一步之前保存的内容还在。',
    }
    if (context.status === 'outcome_unknown') return {
      title: '还不知道模型有没有回完',
      detail: 'App 已停止等待，这次没有收到能确认结果的回复。',
      remediation: '先看对话里有没有可用的回复，再决定是否重试。',
    }
    if (code === 'MODEL_OUTPUT_TRUNCATED') return {
      title: '模型回复太长，被截断了',
      detail: '这次只收到一部分内容，还不能完成这一步。',
      remediation: '可以重试这一步。多次出现时，可把任务分小一点再试。',
    }
    if (code === 'MODEL_RESPONSE_INVALID' || code === 'INVALID_REQUEST') return {
      title: code === 'INVALID_REQUEST' ? '模型服务没有接受这次请求' : '模型回了话，但回复格式没对上',
      detail: 'App 没能用这次回复保存新成果。',
      remediation: '回到对话重试这一步，可以继续用已有材料。反复出现时，可在模型设置中换用已验证的模型。',
    }
    if (code === 'AUTH_FAILED' || code === 'QUOTA_EXCEEDED' || code === 'MODEL_UNSUPPORTED') return {
      title: code === 'AUTH_FAILED' ? '模型服务没有通过账号验证' : code === 'QUOTA_EXCEEDED'
        ? '模型服务的用量额度不足' : '模型服务不支持这次用的模型',
      detail: '这一步没有拿到可用的回复。',
      remediation: code === 'QUOTA_EXCEEDED' ? '检查模型服务的账户额度，或换用另一个已验证的模型。'
        : '在模型设置里测试连接，检查密钥和模型选择后再重试。',
    }
    if (code === 'RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE' || code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'ABORTED') return {
      title: code === 'RATE_LIMITED' ? '模型服务暂时限制了请求' : code === 'PROVIDER_UNAVAILABLE' ? '模型服务暂时不可用'
        : code === 'NETWORK_ERROR' ? '这次没有连上模型服务' : code === 'TIMEOUT' ? '等模型回复时超时了' : '这次模型请求已停止',
      detail: '这次没有完成新的回复，已保存的内容还在。',
      remediation: '可以稍后重试这一步。反复出现时，在模型设置里测试连接。',
    }
    return {
      title: '这次没有拿到可用的模型回复',
      detail: '记录里没有更具体的原因。',
      remediation: '可以在模型设置里测试连接，再回到对话重试。',
    }
  }

  if (technicalName === 'submit_writing_stage' && (code?.startsWith('STAGE_') || code?.startsWith('WORKFLOW_'))) return {
    title: '这一步的成果没能保存',
    detail: 'App 检查这次提交时发现问题，已保存的上一版内容仍可查看。',
    remediation: '回到对话重试这一步。若想先看已保存的正文，打开「稿件与版本」。',
  }

  if (code === 'FACT_SEARCH_DISABLED') return {
    title: '外部事实搜索已关闭',
    detail: '本次没有联网搜索。',
    remediation: '可以让助手只用已有材料核对。需要找新资料时，在设置里开启搜索。',
  }

  if (technicalName === 'read_author_web') {
    if (code === 'WEB_ARTICLE_ACCESS_RESTRICTED') return {
      title: '微信要求验证，文章没打开',
      detail: '这次打开后看到的是验证或访问提示页，没读到文章正文。',
      remediation: '可以在微信里打开原文，再把正文贴给助手。',
    }
    if (code === 'WEB_ARTICLE_UNAVAILABLE') return {
      title: '微信文章已不可用',
      detail: '网页提示文章已删除或不能查看，这次没能把它保存为材料。',
      remediation: '提供仍可访问的文章链接，或提供你已取得的正文。',
    }
    if (code === 'WEB_ARTICLE_CONTENT_MISSING' || code === 'AUTHOR_WEB_CONTENT_EMPTY') return {
      title: '打开了网页，但没读到文章正文',
      detail: '这次没有取得可供写作使用的文字。',
      remediation: '可以发直接指向文章的链接，或把正文贴到对话里。',
    }
    if (code === 'AUTHOR_WEB_LIMIT_REACHED') return {
      title: '本轮网页读取次数已达上限',
      detail: '这一轮最多打开 3 个网页，App 没有再打开这条链接。',
      remediation: '先使用已保存材料，其他链接可以下一轮继续读取。',
    }
    if (code === 'ABORTED' || code === 'WEB_REQUEST_ABORTED') return {
      title: code === 'ABORTED' ? '网页读取已停止' : '网页读取超时或被取消',
      detail: '这次没有把文章正文读完整。',
      remediation: '需要这份资料的话，可以让助手再读一次，也可以直接贴正文。',
    }
    return {
      title: '没能把你给的网页保存为材料',
      detail: '这次没有拿到可以保存的正文。',
      remediation: '可以在浏览器里打开网页检查，或直接把正文贴给助手。',
    }
  }

  if (technicalName === 'search_research_sources' || technicalName === 'search_fact_sources') {
    if (code === 'SEARCH_HTTP_429') return {
      title: '搜索服务暂时限制了请求',
      detail: '这次搜索没有拿到结果。',
      remediation: '如果对话停在这里，可以稍后重试，也可以用已有资料继续。',
    }
    if (code === 'SEARCH_NO_RESULTS') return {
      title: '这次搜索没有找到可用结果',
      detail: '已经提交搜索，未取得能用的资料。',
      remediation: '可以让助手换个搜法，也可以用手头的资料继续。',
    }
    if (code === 'SEARCH_API_KEY_REQUIRED' || code === 'SEARCH_HTTP_401' || code === 'SEARCH_HTTP_403') return {
      title: '这次没能使用搜索服务',
      detail: '搜索服务缺少可用的账号凭据，或拒绝了请求。',
      remediation: '可在搜索设置里检查所用服务，或用已有资料继续。',
    }
    if (code === 'SEARCH_USER_DECLINED') return {
      title: '这次没有联网搜索',
      detail: '你选择了先不搜索，已找到的资料还在。',
      remediation: '可以用已有资料继续。需要公开资料时，再回到对话提出搜索。',
    }
  }

  if (technicalName === 'search_research_sources') return {
    title: code === 'SEARCH_TIMEOUT' || code === 'SEARCH_REQUEST_TIMEOUT' ? '找资料时等到超时'
      : code === 'SEARCH_LIMIT_REACHED' ? '这轮找资料的搜索次数已用完' : '这次搜索没找到可用资料',
    detail: code === 'SEARCH_LIMIT_REACHED' ? 'App 没有再发出搜索请求。已经找到的资料还在。'
      : '这一步没有新增可用材料。',
    remediation: '已有材料够写时，助手可以沿原题继续。也可以在对话里补充你手头的材料。',
  }

  if (technicalName === 'search_fact_sources') {
    if (code === 'SEARCH_TIMEOUT' || code === 'SEARCH_REQUEST_TIMEOUT') return {
      title: '等搜索结果时超时了',
      detail: '这次没有找到可用的新材料。',
      remediation: '回到对话，可以重试本次搜索，或用已有材料继续核查。',
    }
    if (code === 'SEARCH_LIMIT_REACHED') return {
      title: '这轮搜索次数已经用完',
      detail: 'App 没有再发出搜索。已经找到的资料还在。',
      remediation: '如果对话里出现搜索选项，可以选择继续搜索，或先用已有资料核对。',
    }
    if (code === 'SEARCH_APPROVAL_TIMEOUT' || code === 'SEARCH_APPROVAL_FAILED' || code === 'SEARCH_NOT_AUTHORIZED') return {
      title: '这次搜索还没有发出去',
      detail: 'App 没拿到可以发出搜索的确认。',
      remediation: '回到对话查看搜索提示。也可以先让助手用已有资料继续。',
    }
    return {
      title: '公开搜索服务请求失败',
      detail: '这次没能取回搜索结果，记录里没有更具体的原因。',
      remediation: '回到对话重试搜索，或用已有材料继续核查。',
    }
  }

  if (technicalName === 'read_fact_record' && (code === 'FACT_RECORD_NOT_FOUND' || code === 'FACT_RECORD_INDEX_INVALID')) return {
    title: '没找到要重新查看的那条资料',
    detail: '这一步只在已保存的资料里找，没有重新联网搜索。',
    remediation: '回到对话重试核查，或让助手使用已经找到的其他资料。',
  }

  if (code === 'PUBLICATION_TITLE_HEADING_COLLISION' || code === 'PUBLICATION_TITLE_REPAIR_REQUIRED') return {
    title: '有候选标题与正文小标题重复',
    detail: '这组候选正在等重复项换一个标题。',
    remediation: '标题专家只需替换重复的编号，其他候选会保留。',
  }

  if (technicalName === 'read_fact_source') {
    if (code === 'FACT_SOURCE_RESULT_NOT_FOUND') return {
      title: '没找到选中的搜索结果',
      detail: '这个编号和本轮已保存的搜索结果对不上。',
      remediation: '用本轮搜索返回的结果编号重新打开，或先用已有材料继续。',
    }
    if (code === 'FACT_SOURCE_NOT_IN_LEDGER') return {
      title: '这一步没有打开网页',
      detail: '这条链接不在本轮搜索结果或已保存的核查资料里。App 没有向该网站发请求。',
      remediation: '如果这条资料很重要，回到对话让助手重新找来源，或把网页正文贴给它。',
    }
    if (code === 'FACT_SOURCE_TIMEOUT') return {
      title: '等网页打开时超时了',
      detail: '这次没能读到网页正文。',
      remediation: '让助手先用已有摘录。如果缺关键内容，可以换一条来源或贴正文。',
    }
    if (code === 'NETWORK_PRIVATE_TARGET_DENIED' || code === 'NETWORK_CREDENTIALS_DENIED') return {
      title: 'App 没有打开这个地址',
      detail: code === 'NETWORK_PRIVATE_TARGET_DENIED'
        ? '最后要打开的是内网地址，App 没有向这个地址发出请求。' : '地址里带有账号或密码等登录信息，App 没有向这个地址发出请求。',
      remediation: '可以提供公开网页，或把你能看到的正文贴到对话里。',
    }
    if (code === 'NETWORK_TARGET_UNRESOLVED') return {
      title: '没有找到这个网站的地址',
      detail: '这次无法通过链接找到网站，因此没读到网页内容。',
      remediation: '可以检查链接能否在浏览器打开，或让助手换一份公开资料。',
    }
    if (code === 'WEB_RESPONSE_TOO_LARGE' || code === 'WEB_ENCODING_INVALID' || code === 'WEB_CONTENT_TYPE_DENIED') return {
      title: code === 'WEB_RESPONSE_TOO_LARGE' ? '网页内容太大，没能读完'
        : code === 'WEB_ENCODING_INVALID' ? '网页内容没能转成可读文字' : '这份网页内容暂时读不了',
      detail: '这次没有取到可以直接用的正文。',
      remediation: '可以贴出需要的片段，或换另一份来源。',
    }
    if (code === 'WEB_HTTP_STATUS_REJECTED') {
      const status = context.httpStatus;
      const known = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
      const meaning = status === 401 ? '网站要求身份验证' : status === 403 ? '网站拒绝访问' : status === 404 ? '页面不存在'
        : status === 429 ? '网站限制请求频率' : known && status >= 500 ? '网站服务异常' : '网站未返回成功响应';
      return { title: meaning, detail: known ? '网站有回应，但这次没拿到网页正文。' : '旧记录只保存了网站没有成功返回的结果。',
        remediation: '可以先用已经找到的摘录，也可以换一个来源。' }
    }
    return {
      title: '这次没能读到网页正文',
      detail: '记录里没有更具体的原因。',
      remediation: '可以让助手先用已有摘录，或换一份能打开的来源。',
    }
  }

  if (technicalName === 'submit_fact_check' || code?.startsWith('FACT_CHECK_') || code?.startsWith('FACT_GATE_')) return {
    title: '这次核查结果没能保存',
    detail: 'App 检查核查结果时发现问题。已保存的稿件还可以在「稿件与版本」里查看。',
    remediation: '回到对话，让助手针对当前稿件重试核查。',
  }

  return {
    title: context.kind === 'agent' ? '助手没能安排下一步' : '这一步没有完成',
    detail: '记录里没有更具体的原因。',
    remediation: '如果对话停在这里，可以重试这一步。需要反馈时，可展开技术详情。',
  }
}
