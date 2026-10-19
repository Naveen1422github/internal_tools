import { Routes, Route } from 'react-router-dom';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Knowledge from './pages/Knowledge';
import Modules from './pages/Modules';
import Tasks from './pages/Tasks';
import Health from './pages/Health';
import NeedsMerge from './pages/NeedsMerge';
import Merge from './pages/Merge';
import Team from './pages/Team';
import Refused from './pages/Refused';
import Projects from './pages/Projects';
import Settings from './pages/Settings';

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/modules" element={<Modules />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/health" element={<Health />} />
        <Route path="/needs-merge" element={<NeedsMerge />} />
        <Route path="/merge/:ref" element={<Merge />} />
        <Route path="/team" element={<Team />} />
        <Route path="/refused" element={<Refused />} />
      </Routes>
    </AppShell>
  );
}
