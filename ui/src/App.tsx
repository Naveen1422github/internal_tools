import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Knowledge from './pages/Knowledge';
import Modules from './pages/Modules';
import Tasks from './pages/Tasks';
import Health from './pages/Health';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/modules" element={<Modules />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/health" element={<Health />} />
      </Routes>
    </AppShell>
  );
}
