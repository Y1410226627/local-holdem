import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('页面缺少 #root 挂载节点');
}

createRoot(container).render(<App />);
