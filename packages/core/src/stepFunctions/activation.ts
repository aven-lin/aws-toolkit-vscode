/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import { join } from 'path'
import * as vscode from 'vscode'
import { AwsContext } from '../shared/awsContext'
import { createStateMachineFromTemplate } from './commands/createStateMachineFromTemplate'
import { publishStateMachine } from './commands/publishStateMachine'
import { Commands } from '../shared/vscode/commands2'

import { ASL_FORMATS, YAML_ASL, JSON_ASL } from './constants/aslFormats'
import { AslVisualizationCDKManager } from './commands/visualizeStateMachine/aslVisualizationCDKManager'
import { renderCdkStateMachineGraph } from './commands/visualizeStateMachine/renderStateMachineGraphCDK'
import { ToolkitError } from '../shared/errors'
import { telemetry } from '../shared/telemetry/telemetry'
import { PerfLog } from '../shared/logger/perfLogger'
import { ASLLanguageClient } from './asl/client'
import { WorkflowStudioEditorProvider } from './workflowStudio/workflowStudioEditorProvider'
import { StateMachineNode } from './explorer/stepFunctionsNodes'
import { downloadStateMachineDefinition } from './commands/downloadStateMachineDefinition'

/**
 * Activate Step Functions related functionality for the extension.
 */
export async function activate(
    extensionContext: vscode.ExtensionContext,
    awsContext: AwsContext,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    globals.visualizationResourcePaths = initalizeWebviewPaths(extensionContext)

    await registerStepFunctionCommands(extensionContext, awsContext, outputChannel)
    initializeCodeLens(extensionContext)

    let onDidOpenAslDoc: vscode.Disposable // eslint-disable-line prefer-const
    // PERFORMANCE: Start the LSP client/server _only_ when the first ASL document is opened.
    // eslint-disable-next-line prefer-const
    onDidOpenAslDoc = vscode.window.onDidChangeActiveTextEditor(async (e) => {
        if (e?.document && ASL_FORMATS.includes(e.document.languageId)) {
            onDidOpenAslDoc?.dispose() // Handler should only run once.
            await startLspServer(extensionContext)
        }
    }, undefined)
    extensionContext.subscriptions.push(onDidOpenAslDoc)

    if (isASLFileOpen()) {
        onDidOpenAslDoc?.dispose()
        await startLspServer(extensionContext)
    }
}

export const previewStateMachineCommand = Commands.declare(
    'aws.previewStateMachine',
    () => async (arg?: vscode.TextEditor | vscode.Uri | StateMachineNode) => {
        await telemetry.run('stepfunctions_previewstatemachine', async () => {
            if (arg instanceof StateMachineNode) {
                return downloadStateMachineDefinition({
                    stateMachineNode: arg,
                    outputChannel: globals.outputChannel,
                    isPreviewAndRender: true,
                })
            }

            arg ??= vscode.window.activeTextEditor
            const input = arg instanceof vscode.Uri ? arg : arg?.document.uri

            if (!input) {
                throw new ToolkitError('No active text editor or document found')
            }

            await WorkflowStudioEditorProvider.openWithWorkflowStudio(input, {
                preserveFocus: true,
                viewColumn: vscode.ViewColumn.Beside,
            })
        })
    }
)

async function registerStepFunctionCommands(
    extensionContext: vscode.ExtensionContext,
    awsContext: AwsContext,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const cdkVisualizationManager = new AslVisualizationCDKManager(extensionContext)

    extensionContext.subscriptions.push(
        previewStateMachineCommand.register(),
        renderCdkStateMachineGraph.register(cdkVisualizationManager),
        Commands.register('aws.stepfunctions.createStateMachineFromTemplate', async () => {
            try {
                await createStateMachineFromTemplate(extensionContext)
            } finally {
                telemetry.stepfunctions_createStateMachineFromTemplate.emit()
            }
        }),
        Commands.register('aws.stepfunctions.publishStateMachine', async (node?: any) => {
            const region: string | undefined = node?.regionCode
            await publishStateMachine(awsContext, outputChannel, region)
        })
    )
}

export function initalizeWebviewPaths(
    context: vscode.ExtensionContext
): (typeof globals)['visualizationResourcePaths'] {
    // Location for script in body of webview that handles input from user
    // and calls the code to render state machine graph

    // Locations for script and css that render the state machine
    const visualizationLibraryCache = join(context.globalStorageUri.fsPath, 'visualization')

    return {
        localWebviewScriptsPath: vscode.Uri.file(context.asAbsolutePath(join('resources', 'js'))),
        webviewBodyScript: vscode.Uri.file(context.asAbsolutePath(join('resources', 'js', 'graphStateMachine.js'))),
        visualizationLibraryCachePath: vscode.Uri.file(visualizationLibraryCache),
        visualizationLibraryScript: vscode.Uri.file(join(visualizationLibraryCache, 'graph.js')),
        visualizationLibraryCSS: vscode.Uri.file(join(visualizationLibraryCache, 'graph.css')),
        // Locations for an additional stylesheet to add Light/Dark/High-Contrast theme support
        stateMachineCustomThemePath: vscode.Uri.file(context.asAbsolutePath(join('resources', 'css'))),
        stateMachineCustomThemeCSS: vscode.Uri.file(
            context.asAbsolutePath(join('resources', 'css', 'stateMachineRender.css'))
        ),
    }
}

async function startLspServer(extensionContext: vscode.ExtensionContext) {
    const perflog = new PerfLog('stepFunctions: start LSP client/server')
    await ASLLanguageClient.create(extensionContext)
    perflog.done()
}

function isASLFileOpen() {
    return vscode.window.visibleTextEditors.some(
        (textEditor) => textEditor?.document && ASL_FORMATS.includes(textEditor.document.languageId)
    )
}

function initializeCodeLens(context: vscode.ExtensionContext) {
    class StepFunctionsCodeLensProvider implements vscode.CodeLensProvider {
        public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
            const topOfDocument = new vscode.Range(0, 0, 0, 0)

            const openCustomEditor = previewStateMachineCommand.build(document.uri).asCodeLens(topOfDocument, {
                title: localize('AWS.command.stepFunctions.openWithWorkflowStudio', 'Open with Workflow Studio'),
            })

            if (ASL_FORMATS.includes(document.languageId)) {
                const publishCommand: vscode.Command = {
                    command: 'aws.stepfunctions.publishStateMachine',
                    title: localize('AWS.stepFunctions.publish', 'Publish to Step Functions'),
                }
                const publishCodeLens = new vscode.CodeLens(topOfDocument, publishCommand)

                return [publishCodeLens, openCustomEditor]
            } else {
                return [openCustomEditor]
            }
        }
    }

    const docSelector = [{ language: JSON_ASL }, { language: YAML_ASL }]

    const codeLensProviderDisposable = vscode.languages.registerCodeLensProvider(
        docSelector,
        new StepFunctionsCodeLensProvider()
    )

    context.subscriptions.push(codeLensProviderDisposable)
}
