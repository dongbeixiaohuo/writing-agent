export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="5.5" fill="#28241F" />
      <path d="M8.9 2.9h6.2a.35.35 0 0 1 .35.35c0 3.2 1.1 5.55 3.3 7.6C15.9 13.45 13.7 17.1 12 21.3c-1.7-4.2-3.9-7.85-6.75-10.45 2.2-2.05 3.3-4.4 3.3-7.6a.35.35 0 0 1 .35-.35Z" fill="#FFF2DE" />
      <path d="M12 12.3v9.2" stroke="#28241F" strokeWidth="0.85" />
      <circle cx="12" cy="12.3" r="1.1" fill="#28241F" />
    </svg>
  )
}
