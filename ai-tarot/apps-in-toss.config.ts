import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'tarororo',
  brand: {
    primaryColor: '#4B5563', // 기능 검증용 중립색. 최종 브랜드 디자인에서 교체합니다.
  },
  permissions: [],
  webBundleDir: 'dist',
});
