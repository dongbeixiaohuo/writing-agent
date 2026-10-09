import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function IconBase({ size = 16, children, ...props }: IconProps) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" {...props}>{children}</svg>
}

export const PanelIcon = (props: IconProps) => <IconBase {...props}><rect x="1.25" y="1.25" width="13.5" height="13.5" rx="3" stroke="currentColor" strokeWidth="1.3" /><path d="M5.5 1.8v12.4" stroke="currentColor" strokeWidth="1.3" /></IconBase>
export const PlusIcon = (props: IconProps) => <IconBase {...props}><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></IconBase>
export const SearchIcon = (props: IconProps) => <IconBase {...props}><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>
export const FolderIcon = (props: IconProps) => <IconBase {...props}><path d="M1.5 4.5h5l1.3 1.6h6.7v6.8H1.5V4.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M1.8 4.5V3.1h4.1l1.2 1.4" stroke="currentColor" strokeWidth="1.3" /></IconBase>
export const SettingsIcon = (props: IconProps) => <IconBase {...props}><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1.3v1.4M8 13.3v1.4M14.7 8h-1.4M2.7 8H1.3M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>
export const DocumentIcon = (props: IconProps) => <IconBase {...props}><path d="M3 1.5h6l4 4v9H3v-13Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9 1.8v4h3.8M5.5 9h5M5.5 11.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></IconBase>
export const ArrowUpIcon = (props: IconProps) => <IconBase {...props}><path d="m4 7 4-4 4 4M8 3v10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></IconBase>
export const StopIcon = (props: IconProps) => <IconBase {...props}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></IconBase>
export const CloseIcon = (props: IconProps) => <IconBase {...props}><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></IconBase>
export const MoreIcon = (props: IconProps) => <IconBase {...props}><circle cx="3.2" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="12.8" cy="8" r="1" fill="currentColor" /></IconBase>
export const TrashIcon = (props: IconProps) => <IconBase {...props}><path d="M3.5 4.5h9M6.2 2.5h3.6l.7 2H5.5l.7-2ZM5 6.5v6M8 6.5v6M11 6.5v6M4.2 4.5l.6 9h6.4l.6-9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></IconBase>
export const EditIcon = (props: IconProps) => <IconBase {...props}><path d="m3 11.8.6-2.7 6.8-6.8 2.3 2.3-6.8 6.8-2.9.4Z" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><path d="M9.5 3.2 11.8 5.5M3 13.5h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /></IconBase>
export const CheckIcon = (props: IconProps) => <IconBase {...props}><path d="m3 8.2 3.1 3.1L13 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></IconBase>
export const ToolIcon = (props: IconProps) => <IconBase {...props}><path d="M6.3 2.1a4 4 0 0 0 4.9 4.9l3 3-4.2 4.2-3-3a4 4 0 0 0-4.9-4.9L5 9.2l2.2-2.2-2.1-2.1 1.2-2.8Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" /></IconBase>
export const MoonIcon = (props: IconProps) => <IconBase {...props}><path d="M12.8 10.7A5.8 5.8 0 0 1 5.3 3.2 6.2 6.2 0 1 0 12.8 10.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></IconBase>
export const SunIcon = (props: IconProps) => <IconBase {...props}><circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></IconBase>
export const MonitorIcon = (props: IconProps) => <IconBase {...props}><rect x="1.5" y="2.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.3" /><path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></IconBase>
