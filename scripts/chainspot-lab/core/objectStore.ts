import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonicalJson';
import { hashCanonical, sha256Bytes } from './hashing';
import { SHA256_PATTERN } from './identity';

export type ObjectEncoding = 'json' | 'binary';

interface ObjectIdentity {
	readonly objectSchemaVersion: 1;
	readonly kind: string;
	readonly encoding: ObjectEncoding;
	readonly payloadSha256: string;
	readonly payloadBytes: number;
}

export interface StoredObjectDescriptor extends ObjectIdentity {
	readonly hash: string;
	readonly payloadFile: 'payload.json' | 'payload.bin';
}

export interface PutObjectResult {
	readonly descriptor: StoredObjectDescriptor;
	readonly reused: boolean;
}

export class ImmutableObjectStore {
	readonly root: string;
	private readonly objectsRoot: string;
	private readonly temporaryRoot: string;

	constructor(root: string) {
		this.root = root;
		this.objectsRoot = join(root, 'objects', 'sha256');
		this.temporaryRoot = join(root, 'objects', '.tmp');
		mkdirSync(this.objectsRoot, { recursive: true });
		mkdirSync(this.temporaryRoot, { recursive: true });
	}

	putJson(kind: string, payload: unknown): PutObjectResult {
		return this.putPayload(kind, 'json', Buffer.from(canonicalJson(payload), 'utf8'));
	}

	putBytes(kind: string, payload: Uint8Array): PutObjectResult {
		return this.putPayload(kind, 'binary', Buffer.from(payload));
	}

	has(hash: string): boolean {
		if (!SHA256_PATTERN.test(hash)) return false;
		if (!existsSync(this.objectDirectory(hash))) return false;
		this.validate(hash);
		return true;
	}

	readJson<T>(hash: string): T {
		const descriptor = this.validate(hash);
		if (descriptor.encoding !== 'json') throw new TypeError(`Object ${hash} is not JSON`);
		return JSON.parse(readFileSync(join(this.objectDirectory(hash), descriptor.payloadFile), 'utf8')) as T;
	}

	readBytes(hash: string): Buffer {
		const descriptor = this.validate(hash);
		return readFileSync(join(this.objectDirectory(hash), descriptor.payloadFile));
	}

	descriptor(hash: string): StoredObjectDescriptor {
		return this.validate(hash);
	}

	relativePath(hash: string): string {
		this.objectDirectory(hash);
		return join('objects', 'sha256', hash.slice(0, 2), hash.slice(2));
	}

	private putPayload(kind: string, encoding: ObjectEncoding, payload: Buffer): PutObjectResult {
		if (kind.length === 0 || kind.trim() !== kind) {
			throw new TypeError('Object kind must be non-empty and have no surrounding whitespace');
		}
		const identity: ObjectIdentity = {
			objectSchemaVersion: 1,
			kind,
			encoding,
			payloadSha256: sha256Bytes(payload),
			payloadBytes: payload.byteLength
		};
		const hash = hashCanonical(identity);
		const payloadFile = encoding === 'json' ? 'payload.json' : 'payload.bin';
		const descriptor: StoredObjectDescriptor = { ...identity, hash, payloadFile };
		const destination = this.objectDirectory(hash);
		if (existsSync(destination)) {
			this.validate(hash);
			return { descriptor, reused: true };
		}

		mkdirSync(join(this.objectsRoot, hash.slice(0, 2)), { recursive: true });
		const temporary = join(this.temporaryRoot, `${hash}-${process.pid}-${randomUUID()}`);
		mkdirSync(temporary);
		try {
			writeFileSync(join(temporary, payloadFile), payload, { flag: 'wx' });
			writeFileSync(join(temporary, 'descriptor.json'), canonicalJson(descriptor), { flag: 'wx' });
			writeFileSync(join(temporary, 'COMPLETE'), '', { flag: 'wx' });
			try {
				renameSync(temporary, destination);
			} catch (error) {
				if (!existsSync(destination)) throw error;
				this.validate(hash);
			}
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { recursive: true });
		}
		return { descriptor, reused: false };
	}

	private objectDirectory(hash: string): string {
		if (!SHA256_PATTERN.test(hash)) throw new TypeError(`Invalid object hash: ${hash}`);
		return join(this.objectsRoot, hash.slice(0, 2), hash.slice(2));
	}

	private validate(hash: string): StoredObjectDescriptor {
		const directory = this.objectDirectory(hash);
		if (!existsSync(join(directory, 'COMPLETE'))) throw new Error(`Object ${hash} is incomplete`);
		const descriptor = JSON.parse(
			readFileSync(join(directory, 'descriptor.json'), 'utf8')
		) as StoredObjectDescriptor;
		if (descriptor.hash !== hash) throw new Error(`Object ${hash} descriptor hash mismatch`);
		if (descriptor.objectSchemaVersion !== 1) throw new Error(`Object ${hash} schema is unsupported`);
		if (descriptor.encoding !== 'json' && descriptor.encoding !== 'binary') {
			throw new Error(`Object ${hash} encoding is unsupported`);
		}
		const expectedPayloadFile = descriptor.encoding === 'json' ? 'payload.json' : 'payload.bin';
		if (descriptor.payloadFile !== expectedPayloadFile) {
			throw new Error(`Object ${hash} payload path is invalid`);
		}
		const payload = readFileSync(join(directory, descriptor.payloadFile));
		if (payload.byteLength !== descriptor.payloadBytes) {
			throw new Error(`Object ${hash} payload length mismatch`);
		}
		if (sha256Bytes(payload) !== descriptor.payloadSha256) {
			throw new Error(`Object ${hash} payload digest mismatch`);
		}
		const identity: ObjectIdentity = {
			objectSchemaVersion: descriptor.objectSchemaVersion,
			kind: descriptor.kind,
			encoding: descriptor.encoding,
			payloadSha256: descriptor.payloadSha256,
			payloadBytes: descriptor.payloadBytes
		};
		if (hashCanonical(identity) !== hash) throw new Error(`Object ${hash} identity mismatch`);
		return descriptor;
	}
}
