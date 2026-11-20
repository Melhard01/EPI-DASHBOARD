import { useParams } from 'react-router';
import SubmissionsView from '../components/submissions/SubmissionsView.jsx';
import { useSession } from '../auth/SessionContext.js';
import { formLabel } from '../lib/labels.js';

export function AllSubmissions() {
  return <SubmissionsView title="All submissions" description="Submissions from every website you can access." />;
}

/** One form of one website. The route guard has already checked access. */
export function FormSubmissions() {
  const { application, formType } = useParams();
  const { application: lookup } = useSession();
  const name = lookup(application)?.name ?? application;
  return (
    <SubmissionsView
      key={`${application}/${formType}`}
      title={`${name} · ${formLabel(formType)}`}
      description={`Submissions of the ${formLabel(formType).toLowerCase()} form on ${name}.`}
      fixedApplication={application}
      fixedFormType={formType}
    />
  );
}
