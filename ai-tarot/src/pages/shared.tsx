import { Button } from '@toss/tds-mobile'
import type { ReactNode } from 'react'

export function PageIntro({ eyebrow = 'tarororo', title, description }: { eyebrow?: string; title: string; description?: string }) { return <header className="page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="intro-description">{description}</p>}</header> }
export function LoadingState({ children = '불러오고 있어요.' }: { children?: ReactNode }) { return <section className="state-card" role="status"><span className="spinner" aria-hidden="true" /><p>{children}</p></section> }
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <section className="state-card" role="alert"><h2>불러오지 못했어요</h2><p>{message}</p><Button display="full" variant="weak" onClick={onRetry}>다시 시도</Button></section> }
