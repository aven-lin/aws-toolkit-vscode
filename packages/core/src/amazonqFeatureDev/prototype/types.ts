import { ChatItemButton, MynahIcons, ProgressField } from '@aws/mynah-ui'
import { DeletedFileInfo, NewFileInfo } from '../../amazonq/commons/types'

export interface ListEventsResponse {
    items?: Array<{
        eventType: string
        eventData: string // base64 encoded string
        timestamp: string
        messageId: string
    }>
    nextToken?: string
    $response?: {
        requestId: string
    }
}

export interface Event {
    eventType: string
    eventData: string // base64 encoded string
    timestamp: string
    messageId: string
}

export interface WorkspaceChangeResult {
    newFiles: NewFileInfo[]
    deletedFiles: DeletedFileInfo[]
}

export interface AgentStatusEvent {
    message: {
        contentType: 'text' | 'markdown'
        value: string
    }
    messageId: string
}

export interface WorkspaceUpdateEvent {
    changes: {
        newFiles: NewFileInfo[]
        deletedFiles: DeletedFileInfo[]
    }
    label?: string
    messageId: string
}

export interface RequestCompleteEvent {
    remainingCount?: number
    totalCount?: number
    messageId: string
}

export type EventHandlers = () => Promise<WorkspaceChangeResult>

export const cancelGenButton: ChatItemButton = {
    id: 'cancel-code-generation',
    text: 'Cancel',
    icon: 'cancel' as MynahIcons,
}

export const inProgress = (progress: number, text: string): ProgressField => {
    return {
        status: 'default',
        text,
        value: progress === 100 ? -1 : progress,
        actions: [cancelGenButton],
    }
}
