import { beforeAll } from 'vitest';
import { setProjectAnnotations } from '@storybook/sveltekit';
import * as previewAnnotations from './preview';

const annotations = setProjectAnnotations([previewAnnotations]);
beforeAll(annotations.beforeAll);
