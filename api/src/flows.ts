import { schedule, validate } from 'node-cron';
import { get } from 'micromustache';
import getDatabase from './database';
import emitter from './emitter';
import logger from './logger';
import { FlowsService } from './services';
import { EventHandler } from './types';
import { getSchema } from './utils/get-schema';
import { constructFlowTree } from './utils/construct-flow-tree';
import {
	OperationHandler,
	Operation,
	Flow,
	FilterHandler,
	ActionHandler,
	InitHandler,
	EventContext,
} from '@directus/shared/types';
import env from './env';
import * as exceptions from './exceptions';
import * as sharedExceptions from '@directus/shared/exceptions';
import * as services from './services';
import { renderMustache } from './utils/render-mustache';

let flowManager: FlowManager | undefined;

export function getFlowManager(): FlowManager {
	if (flowManager) {
		return flowManager;
	}

	flowManager = new FlowManager();

	return flowManager;
}

const TRIGGER_KEY = '$trigger';
const ACCOUNTABILITY_KEY = '$accountability';
const LAST_KEY = '$last';

class FlowManager {
	private operations: Record<string, OperationHandler> = {};

	private triggerHandlers: EventHandler[] = [];
	private operationFlowHandlers: Record<string, any> = {};
	private webhookFlowHandlers: Record<string, any> = {};

	private flowOperations: Record<string, any> = {};

	public async initialize(): Promise<void> {
		const flowsService = new FlowsService({ knex: getDatabase(), schema: await getSchema() });

		const flows = await flowsService.readByQuery({
			filter: { status: { _eq: 'active' } },
			fields: ['*', 'operations.*'],
		});

		for (const flow of flows) {
			for (const operationRaw of flow.operations) {
				const operation = {
					...operationRaw,
					resolve: null,
					reject: null,
				};

				const handler = (data: Record<string, unknown>) => this.executeOperation(operation, data);

				this.flowOperations[operation.id] = handler;
			}
		}

		const flowTrees = flows.map((flow) => constructFlowTree(flow));

		for (const flow of flowTrees) {
			if (flow.trigger === 'hook') {
				if (flow.options.type === 'filter') {
					const handler: FilterHandler = (payload, meta, context) =>
						this.executeFlow(
							flow,
							{ payload, ...meta },
							{
								accountability: context.accountability,
								database: context.database,
								getSchema: context.schema ? () => context.schema : getSchema,
							}
						);

					const events: string[] =
						flow.options?.filterScope
							?.map((scope: string) => {
								if (['items.create', 'items.update', 'items.delete'].includes(scope)) {
									return (
										flow.options?.filterCollections?.map((collection: string) => {
											if (collection.startsWith('directus_')) {
												const action = scope.split('.')[1];
												return collection.substring(9) + '.' + action;
											}

											return `${collection}.${scope}`;
										}) ?? []
									);
								}

								return scope;
							})
							?.flat() ?? [];

					events.forEach((event) => emitter.onFilter(event, handler));
					this.triggerHandlers.push({ type: 'filter', id: flow.id, events, handler });
				}

				if (flow.options.type === 'action') {
					const handler: ActionHandler = (meta, context) =>
						this.executeFlow(flow, meta, {
							accountability: context.accountability,
							database: context.database,
							getSchema: context.schema ? () => context.schema : getSchema,
						});

					const events: string[] =
						flow.options?.actionScope
							?.map((scope: string) => {
								if (['items.create', 'items.update', 'items.delete'].includes(scope)) {
									return (
										flow.options?.actionCollections?.map((collection: string) => {
											if (collection.startsWith('directus_')) {
												const action = scope.split('.')[1];
												return collection.substring(9) + '.' + action;
											}

											return `${collection}.${scope}`;
										}) ?? []
									);
								}

								return scope;
							})
							?.flat() ?? [];

					events.forEach((event) => emitter.onAction(event, handler));
					this.triggerHandlers.push({ type: 'action', id: flow.id, events, handler });
				}

				if (flow.options.type === 'init') {
					const handler: InitHandler = () => this.executeFlow(flow);
					const events: string[] = flow.options.initScope ?? [];
					events.forEach((event) => emitter.onInit(event, handler));
					this.triggerHandlers.push({ type: 'init', id: flow.id, events, handler });
				}
			} else if (flow.trigger === 'schedule') {
				if (validate(flow.options.cron)) {
					const task = schedule(flow.options.cron, () => this.executeFlow(flow));

					this.triggerHandlers.push({ type: flow.trigger, task });
				} else {
					logger.warn(`Couldn't register cron trigger. Provided cron is invalid: ${flow.options.cron}`);
				}
			} else if (flow.trigger === 'operation') {
				const handler = (data: unknown, context: Record<string, unknown>) => this.executeFlow(flow, data, context);

				this.operationFlowHandlers[flow.id] = handler;
			} else if (flow.trigger === 'webhook' || flow.trigger === 'manual') {
				const handler = (data: unknown, context: Record<string, unknown>) => this.executeFlow(flow, data, context);

				const method = flow.options?.method ?? 'GET';

				this.webhookFlowHandlers[`${method}-${flow.id}`] = handler;
			}
		}
	}

	public async reload(): Promise<void> {
		for (const trigger of this.triggerHandlers) {
			switch (trigger.type) {
				case 'filter':
					trigger.events.forEach((event) => emitter.offFilter(event, trigger.handler));
					break;
				case 'action':
					trigger.events.forEach((event) => emitter.offAction(event, trigger.handler));
					break;
				case 'init':
					trigger.events.forEach((event) => emitter.offInit(event, trigger.handler));
					break;
				case 'schedule':
					trigger.task.stop();
					break;
			}
		}

		this.triggerHandlers = [];
		this.operationFlowHandlers = {};
		this.webhookFlowHandlers = {};

		this.flowOperations = {};

		await this.initialize();
	}

	public addOperation(id: string, operation: OperationHandler): void {
		this.operations[id] = operation;
	}

	public clearOperations(): void {
		this.operations = {};
	}

	public async runOperationFlow(id: string, data: unknown, context: Record<string, unknown>): Promise<unknown> {
		if (!(id in this.operationFlowHandlers)) {
			logger.warn(`Couldn't find operation triggered flow with id "${id}"`);
			return null;
		}

		const handler = this.operationFlowHandlers[id];

		return handler(data, context);
	}

	public async runWebhookFlow(id: string, data: unknown, context: Record<string, unknown>): Promise<unknown> {
		if (!(id in this.webhookFlowHandlers)) {
			logger.warn(`Couldn't find webhook triggered flow with id "${id}"`);
			throw new exceptions.ForbiddenException();
		}

		const handler = this.webhookFlowHandlers[id];

		return handler(data, context);
	}

	public async runOperation(id: string, data: unknown): Promise<unknown> {
		if (!(id in this.flowOperations)) {
			logger.warn(`Couldn't find operation with id "${id}"`);

			return null;
		}

		const handler = this.flowOperations[id];

		return handler(data);
	}

	private async executeFlow(flow: Flow, data: unknown = null, context: Record<string, unknown> = {}): Promise<unknown> {
		const keyedData: Record<string, unknown> = {
			[TRIGGER_KEY]: data,
			[LAST_KEY]: data,
			[ACCOUNTABILITY_KEY]: context?.accountability ?? null,
		};

		let nextOperation = flow.operation;

		while (nextOperation !== null) {
			const { successor, data } = await this.executeOperation(nextOperation, keyedData, context);

			keyedData[nextOperation.key] = data;
			keyedData[LAST_KEY] = data;

			nextOperation = successor;
		}

		if (flow.options.return) {
			return get(keyedData, flow.options.return);
		}

		return null;
	}

	private async executeOperation(
		operation: Operation,
		keyedData: Record<string, unknown>,
		context: Record<string, unknown> = {}
	): Promise<{ successor: Operation | null; data: unknown }> {
		if (!(operation.type in this.operations)) {
			logger.warn(`Couldn't find operation ${operation.type}`);

			return { successor: null, data: null };
		}

		const handler = this.operations[operation.type];

		const options = renderMustache(operation.options, keyedData);

		try {
			const result = await handler(options, {
				services,
				exceptions: { ...exceptions, ...sharedExceptions },
				env,
				database: getDatabase(),
				logger,
				getSchema,
				data: keyedData,
				accountability: null,
				...context,
			});

			return { successor: operation.resolve, data: result ?? null };
		} catch (error: unknown) {
			if (!operation.reject) logger.warn(`Unhandled error in operation "${operation.key}": ${error}`);
			return { successor: operation.reject, data: error ?? null };
		}
	}
}