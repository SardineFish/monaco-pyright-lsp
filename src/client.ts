// import type { } from "pyright/packages/pyright-internal/src/server";
import
{
    BrowserMessageReader,
    DefinitionRequest,
    BrowserMessageWriter,
    createMessageConnection,
    DataCallback,
    Disposable,
    Event,
    MessageReader,
    PartialMessageInfo,
    SharedArraySenderStrategy,
    SharedArrayReceiverStrategy,
    MessageConnection,
    CompletionList,
    CompletionItem,
    NotificationType,
    DidChangeTextDocumentParams,
    CompletionParams,
    Position,
    CompletionRequest,
    CompletionResolveRequest,
    InitializeParams,
    DiagnosticTag,
    InitializeRequest,
    DidChangeConfigurationParams,
    DidOpenTextDocumentParams,
    PublishDiagnosticsParams,
    Diagnostic,
    LogMessageParams,
    ConfigurationParams,
    RequestType,
    HoverParams,
    HoverRequest,
    SignatureHelpParams,
    SignatureHelpRequest,
    SignatureHelp,
    Hover,
    DidChangeConfigurationNotification,
    DefinitionParams,
    TextDocumentIdentifier,
    RenameRequest,
    RenameParams,
    PrepareRenameRequest,
    PrepareRenameParams,
    PrepareRenameResult,
    WorkspaceEdit,
    DidCreateFilesNotification,
    WillCreateFilesRequest,
    PublishDiagnosticsNotification,
} from "vscode-languageserver/browser";
import { InitializeMsg, MsgInitServer, MsgOfType, MsgServerLoaded, UserFolder } from "./message";
// import Worker from "./worker.ts";


declare global
{
    interface Promise<T>
    {
        ignoreErrors(): void
    }
}

// For a single file editor, we use a constant script file url.
const documentUri = 'file:///untitled';

interface DiagnosticRequest
{
    callback: (diags: Diagnostic[], error?: Error) => void;
}

export class LspClient
{
    connection: MessageConnection = null as any;
    docVersion = 1;
    docText = "";
    worker: Worker;
    workerLoadedPromise: Promise<MsgServerLoaded>;

    private _documentDiags: PublishDiagnosticsParams | undefined;

    static docUri = documentUri;

    constructor(worker_url?: string)
    {
        if (worker_url)
        {
            this.worker = new Worker(worker_url);   
        }
        else
        {
            this.worker = new Worker(new URL("./worker.js", import.meta.url));
        }

        this.workerLoadedPromise = this.waitServerInitializeMsg("serverLoaded");
    }

    public async initialize(projectPath: string, userFiles: UserFolder = {})
    {
        await this.workerLoadedPromise;

        this.worker.postMessage(<MsgInitServer>{
            type: "initServer",
            userFiles: userFiles,
        });

        await this.waitServerInitializeMsg("serverInitialized");


        const reader = new BrowserMessageReader(this.worker);
        const writer = new BrowserMessageWriter(this.worker);

        this.connection = createMessageConnection(reader, writer, console, {
            // cancellationStrategy: {
            //     sender: new SharedArraySenderStrategy(),
            //     receiver: new SharedArrayReceiverStrategy()
            // }
        });

        this.connection.listen();
        // Initialize the server.
        const init: InitializeParams = {
            rootUri: `file://${projectPath}`,
            rootPath: projectPath,
            processId: 1,
            capabilities: {
                textDocument: {
                    publishDiagnostics: {
                        tagSupport: {
                            valueSet: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated],
                        },
                        versionSupport: true,
                    },
                    hover: {
                        contentFormat: ['markdown', 'plaintext'],
                    },
                    signatureHelp: {},
                },
            },
        };


        this.docVersion = 1;
        this.docText = "";

        await this.connection.sendRequest(InitializeRequest.type, init);

        // Update the settings.
        await this.connection.sendNotification(
            new NotificationType<DidChangeConfigurationParams>('workspace/didChangeConfiguration'),
            {
                settings: {},
            }
        );

        // Simulate an "open file" event.
        await this.connection.sendNotification(
            new NotificationType<DidOpenTextDocumentParams>('textDocument/didOpen'),
            {
                textDocument: {
                    uri: documentUri,
                    languageId: 'python',
                    version: this.docVersion,
                    text: this.docText,
                },
            }
        );


        // Log messages received by the language server for debugging purposes.
        this.connection.onNotification(
            new NotificationType<LogMessageParams>('window/logMessage'),
            (info) =>
            {
                console.info(`Language server log message: ${info.message}`);
            }
        );

        // Handle requests for configurations.
        this.connection.onRequest(
            new RequestType<ConfigurationParams, any, any>('workspace/configuration'),
            (params) =>
            {
                // console.info(`Language server config request: ${JSON.stringify(params)}}`);
                return [];
            }
        );
    }

    private waitServerInitializeMsg<T extends InitializeMsg["type"]>(msgType: T) : Promise<MsgOfType<T>>
    {
        return new Promise((resolve, reject) =>
        {
            this.worker.onmessage = (msgEv) =>
            {
                const msg = msgEv.data as InitializeMsg;
                if (msg.type === msgType)
                {
                    resolve(msg as MsgOfType<T>);
                }
                else
                {
                    reject({
                        reason: "Message mismatch",
                        msg: msg
                    });
                }
            }
        });
    }

    async setupDiagnosticsCallback(callback: (diagnostics: Diagnostic[]) => void)
    {
        // Receive diagnostics from the language server.
        this.connection.onNotification(
            new NotificationType<PublishDiagnosticsParams>('textDocument/publishDiagnostics'),
            (diagInfo) =>
            {
                const diagVersion = diagInfo.version ?? -1;

                // console.info(`Received diagnostics for version: ${diagVersion}`);

                // Update the cached diagnostics.
                if (
                    this._documentDiags === undefined ||
                    this._documentDiags.version! < diagVersion
                )
                {
                    this._documentDiags = diagInfo;
                }

                callback(diagInfo.diagnostics);
            }
        );
    }

    async updateDocVersion(doc: string): Promise<number>
    {
        let documentVersion = this.docVersion;
        if (this.docText !== doc)
        {
            documentVersion = await this.updateTextDocument(doc);
        }

        return documentVersion;
    }

    getDocIdentifier(): TextDocumentIdentifier
    {
        return {
            uri: documentUri
        };
    }

    async rename(doc: string, position: Position, newName: string): Promise<WorkspaceEdit | null>
    {
        this.updateDocVersion(doc);

        const params: RenameParams = {
            textDocument: this.getDocIdentifier(),
            newName,
            position,
        };

        const result = await this.connection.sendRequest(RenameRequest.type, params);
        return result;
    }

    async parepareRename(doc: string, position: Position): Promise<PrepareRenameResult | null>
    {
        this.updateDocVersion(doc);

        const params: PrepareRenameParams = {
            textDocument: this.getDocIdentifier(),
            position,
        };

        return await this.connection.sendRequest(PrepareRenameRequest.type, params);
    }

    async getDefinition(doc: string, position: Position)
    {
        await this.updateDocVersion(doc);
        
        const params: DefinitionParams = {
            position,
            textDocument: this.getDocIdentifier(),
        };
        return await this.connection.sendRequest(DefinitionRequest.type, params);
    }

    async getCompletion(
        code: string,
        position: Position
    ): Promise<CompletionList | CompletionItem[] | null>
    {
        await this.updateDocVersion(code);

        const params: CompletionParams = {
            textDocument: {
                uri: documentUri,
            },
            position,
        };

        const result = await this.connection
            .sendRequest(CompletionRequest.type, params)
            .catch((err) =>
            {
                // Don't return an error. Just return null (no info).
                return null;
            });

        return result;
    }

    async resolveCompletion(completionItem: CompletionItem): Promise<CompletionItem | null>
    {
        const result = await this.connection
            .sendRequest(CompletionResolveRequest.type, completionItem)
            .catch((err) =>
            {
                // Don't return an error. Just return null (no info).
                return null;
            });

        return result;
    }

    async getHoverInfo(code: string, position: Position): Promise<Hover | null>
    {
        let documentVersion = this.docVersion;
        if (this.docText !== code)
        {
            documentVersion = await this.updateTextDocument(code);
        }

        const params: HoverParams = {
            textDocument: {
                uri: documentUri,
            },
            position,
        };

        const result = await this.connection
            .sendRequest(HoverRequest.type, params)
            .catch((err) =>
            {
                // Don't return an error. Just return null (no info).
                return null;
            });

        return result;
    }

    async getSignatureHelp(code: string, position: Position): Promise<SignatureHelp | null>
    {
        let documentVersion = this.docVersion;
        if (this.docText !== code)
        {
            documentVersion = await this.updateTextDocument(code);
        }

        const params: SignatureHelpParams = {
            textDocument: {
                uri: documentUri,
            },
            position,
        };

        const result = await this.connection
            .sendRequest(SignatureHelpRequest.type, params)
            .catch((err) =>
            {
                // Don't return an error. Just return null (no info).
                return null;
            });

        return result;
    }

    async updateSettings(): Promise<void>
    {
        await this.connection
            .sendNotification(DidChangeConfigurationNotification.type, {
                settings: {
                    python: {
                        analysis: {
                            typeshedPaths: [
                                "/typeshed-fallback"
                            ]
                        },
                        pythonVersion: "3.13",
                        pythonPlatform: "All",
                    }
                }
            });
    }

    // Sends a new version of the text document to the language server.
    // It bumps the document version and returns the new version number.
    private async updateTextDocument(code: string): Promise<number>
    {
        ++this.docVersion;
        // console.info(`Updating text document to version ${this.docVersion}`);

        // Send the updated text to the language server.
        return this.connection
            .sendNotification(
                new NotificationType<DidChangeTextDocumentParams>('textDocument/didChange'),
                {
                    textDocument: {
                        uri: documentUri,
                        version: this.docVersion,
                    },
                    contentChanges: [
                        {
                            text: code,
                        },
                    ],
                }
            )
            .then(() =>
            {
                // console.info(`Successfully sent text document to language server`);
                return this.docVersion;
            })
            .catch((err) =>
            {
                console.error(`Error sending text document to language server: ${err}`);
                throw err;
            });
    }
}

