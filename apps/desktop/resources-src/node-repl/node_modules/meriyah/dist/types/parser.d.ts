import { Context } from './common';
import type * as ESTree from './estree';
import { type Options } from './options';
export declare function parseSource(source: string, rawOptions?: Options, context?: Context): ESTree.Program;
