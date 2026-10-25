import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({plugins: [vue()], root:'web', build: {outDir:'dist', emptyOutDir:true, target:'es2022'}, server:{proxy:{'/api':'http://127.0.0.1:8787','/health':'http://127.0.0.1:8787'}}});
